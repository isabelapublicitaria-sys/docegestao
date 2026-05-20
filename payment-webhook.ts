import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json();
    const url = new URL(req.url);
    const source = url.searchParams.get("source") || "unknown";

    console.log("Webhook recebido:", source, JSON.stringify(body));

    // ─── MERCADO PAGO ───────────────────────────────────────
    if (body.type === "payment" && body.data?.id) {
      const paymentId = body.data.id;

      // Buscar detalhes do pagamento no MP
      // Precisamos do access_token — buscamos pelo external_reference na venda
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${body.user_id || ""}` },
      });

      // Alternativa: buscar a venda pelo payment_id e pegar o token do perfil
      const { data: vendas } = await supabase
        .from("vendas")
        .select("id, user_id, payment_status")
        .eq("payment_id", String(paymentId))
        .limit(1);

      if (vendas && vendas.length > 0) {
        const venda = vendas[0];

        // Buscar token do confeiteiro
        const { data: perfil } = await supabase
          .from("perfis")
          .select("mp_access_token")
          .eq("user_id", venda.user_id)
          .single();

        if (perfil?.mp_access_token) {
          const detalhes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${perfil.mp_access_token}` },
          });
          const mpPayment = await detalhes.json();

          const status = mpPayment.status === "approved" ? "paid"
            : mpPayment.status === "rejected" ? "failed"
            : "pending";

          await supabase
            .from("vendas")
            .update({ payment_status: status })
            .eq("id", venda.id);

          console.log(`Venda ${venda.id} atualizada para ${status}`);
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── INFINITEPAY ────────────────────────────────────────
    if (body.order_nsu || body.invoice_slug) {
      const orderRef = body.order_nsu;
      const paid = body.paid === true || body.capture_method !== undefined;

      if (orderRef) {
        const status = paid ? "paid" : "failed";

        // Buscar venda pelo payment_id (que é o orderRef)
        const { data: vendas } = await supabase
          .from("vendas")
          .select("id, payment_status")
          .eq("payment_id", orderRef)
          .limit(1);

        if (vendas && vendas.length > 0) {
          await supabase
            .from("vendas")
            .update({
              payment_status: status,
              payment_id: body.transaction_nsu || orderRef,
            })
            .eq("id", vendas[0].id);

          console.log(`Venda ${vendas[0].id} atualizada para ${status} via InfinitePay`);
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ received: true, ignored: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("Erro no webhook:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 200, // sempre 200 para o gateway não retentar infinitamente
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
