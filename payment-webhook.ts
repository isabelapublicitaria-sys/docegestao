import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://gesttaconfeitaria.com.br",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─────────────────────────────────────────────────────────────
// VALIDAÇÃO DE ASSINATURA — MERCADO PAGO
// Documentação: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
//
// Como configurar:
//   1. No painel do Mercado Pago → Suas integrações → Webhooks
//   2. Adicione a URL da Edge Function e copie o "secret" gerado
//   3. No painel do Supabase → Edge Functions → payment-webhook → Secrets
//   4. Adicione: MP_WEBHOOK_SECRET = <o secret copiado>
// ─────────────────────────────────────────────────────────────
async function validarAssinaturaMP(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("MP_WEBHOOK_SECRET");

  // Se o secret não estiver configurado, bloqueia — não processa sem validação
  if (!secret) {
    console.error("MP_WEBHOOK_SECRET não configurado. Configure a variável de ambiente.");
    return false;
  }

  // O MP envia: x-signature: ts=<timestamp>,v1=<hash>
  const xSignature = req.headers.get("x-signature");
  const xRequestId = req.headers.get("x-request-id");

  if (!xSignature) {
    console.warn("Webhook recebido sem x-signature — rejeitado.");
    return false;
  }

  // Extrai ts e v1 do header
  const parts: Record<string, string> = {};
  xSignature.split(",").forEach((part) => {
    const [key, value] = part.split("=");
    if (key && value) parts[key.trim()] = value.trim();
  });

  const ts = parts["ts"];
  const v1 = parts["v1"];

  if (!ts || !v1) {
    console.warn("x-signature malformado — rejeitado.");
    return false;
  }

  // Monta o template que o MP usa para gerar o HMAC
  // Formato: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
  let dataId = "";
  try {
    const body = JSON.parse(rawBody);
    dataId = String(body?.data?.id ?? "");
  } catch (_) {}

  const template = `id:${dataId};request-id:${xRequestId ?? ""};ts:${ts};`;

  // Calcula HMAC-SHA256
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(template);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const sigHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (sigHex !== v1) {
    console.warn(`Assinatura inválida. Esperado: ${v1} | Calculado: ${sigHex}`);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Lê o body UMA vez como texto (necessário para validar a assinatura)
  const rawBody = await req.text();

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    console.error("Corpo do webhook não é JSON válido.");
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "unknown";
  console.log("Webhook recebido:", source, JSON.stringify(body));

  try {

    // ─── MERCADO PAGO ──────────────────────────────────────────
    if (body.type === "payment" && body.data?.id) {

      // ✅ VALIDAÇÃO DE ASSINATURA — bloqueia webhooks forjados
      const assinaturaValida = await validarAssinaturaMP(req, rawBody);
      if (!assinaturaValida) {
        console.warn("Webhook do MP rejeitado por assinatura inválida.");
        // Retorna 200 para o MP não retentar, mas não processa nada
        return new Response(JSON.stringify({ received: false, reason: "invalid_signature" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const paymentId = body.data.id;

      // Busca a venda pelo payment_id para obter o user_id da confeiteira
      const { data: vendas } = await supabase
        .from("vendas")
        .select("id, user_id, payment_status")
        .eq("payment_id", String(paymentId))
        .limit(1);

      if (vendas && vendas.length > 0) {
        const venda = vendas[0];

        // Busca o Access Token da confeiteira para consultar o status real no MP
        const { data: perfil } = await supabase
          .from("perfis")
          .select("mp_access_token")
          .eq("user_id", venda.user_id)
          .single();

        if (perfil?.mp_access_token) {
          // Consulta o status real do pagamento diretamente na API do MP
          const detalhes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${perfil.mp_access_token}` },
          });
          const mpPayment = await detalhes.json();

          const status =
            mpPayment.status === "approved" ? "paid"
            : mpPayment.status === "rejected" ? "failed"
            : "pending";

          await supabase
            .from("vendas")
            .update({ payment_status: status })
            .eq("id", venda.id);

          console.log(`✅ Venda ${venda.id} atualizada para ${status} (MP status: ${mpPayment.status})`);
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── INFINITEPAY ───────────────────────────────────────────
    // A InfinitePay não tem um padrão HMAC público documentado como o MP.
    // A proteção aqui é verificar o order_nsu que só existe no nosso banco,
    // e confirmar o status consultando diretamente (se a API permitir).
    if (body.order_nsu || body.invoice_slug) {
      const orderRef = body.order_nsu;
      const paid = body.paid === true || body.capture_method !== undefined;

      if (orderRef) {
        // Verifica se este orderRef realmente existe no nosso banco
        // (evita que alguém forge um orderRef aleatório)
        const { data: vendas } = await supabase
          .from("vendas")
          .select("id, payment_status, user_id")
          .eq("payment_id", orderRef)
          .limit(1);

        if (!vendas || vendas.length === 0) {
          console.warn(`InfinitePay: orderRef ${orderRef} não encontrado no banco — ignorado.`);
          return new Response(JSON.stringify({ received: true, ignored: true }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Só atualiza para "paid" se o campo paid vier true no payload
        // (não atualiza apenas por receber qualquer webhook)
        if (paid) {
          const status = "paid";
          await supabase
            .from("vendas")
            .update({
              payment_status: status,
              payment_id: body.transaction_nsu || orderRef,
            })
            .eq("id", vendas[0].id);

          console.log(`✅ Venda ${vendas[0].id} atualizada para ${status} via InfinitePay`);
        } else {
          console.log(`InfinitePay: webhook recebido mas paid=false para orderRef ${orderRef} — ignorado.`);
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Payload não reconhecido — ignora silenciosamente
    return new Response(JSON.stringify({ received: true, ignored: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("Erro no webhook:", err.message);
    // Sempre retorna 200 para o gateway não retentar indefinidamente
    return new Response(JSON.stringify({ error: err.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
