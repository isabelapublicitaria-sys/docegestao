import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { user_id, items, total, cliente_nome, cliente_tel, cliente_email, order_ref } = await req.json();

    // Buscar credenciais do confeiteiro
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: perfil, error } = await supabase
      .from("perfis")
      .select("payment_gateway, mp_access_token, infinitepay_tag, empresa")
      .eq("user_id", user_id)
      .single();

    if (error || !perfil) throw new Error("Perfil não encontrado");
    if (!perfil.payment_gateway) throw new Error("Gateway de pagamento não configurado");

    // Criar venda pendente no banco
    const { data: venda, error: vendaError } = await supabase
      .from("vendas")
      .insert({
        user_id,
        cliente_nome,
        cliente_tel,
        total,
        itens: items,
        payment_status: "pending",
        payment_method: perfil.payment_gateway,
        data: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (vendaError) throw new Error("Erro ao criar venda: " + vendaError.message);

    const vendaId = venda.id;
    const orderRef = `${user_id.slice(0,8)}-${vendaId}`;

    let paymentUrl = "";

    // ─── MERCADO PAGO ───────────────────────────────────────
    if (perfil.payment_gateway === "mercadopago") {
      if (!perfil.mp_access_token) throw new Error("Access Token do Mercado Pago não configurado");

      const mpBody = {
        items: items.map((item: any) => ({
          title: item.nome,
          quantity: item.qty,
          unit_price: Number(item.preco),
          currency_id: "BRL",
        })),
        payer: {
          name: cliente_nome || "Cliente",
          email: cliente_email || "cliente@email.com",
          phone: { number: (cliente_tel || "").replace(/\D/g, "") },
        },
        external_reference: orderRef,
        notification_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/payment-webhook`,
        back_urls: {
          success: `https://isabelapublicitaria-sys.github.io/docegestao/cardapio.html?pagamento=sucesso&ref=${orderRef}`,
          failure: `https://isabelapublicitaria-sys.github.io/docegestao/cardapio.html?pagamento=falhou&ref=${orderRef}`,
          pending: `https://isabelapublicitaria-sys.github.io/docegestao/cardapio.html?pagamento=pendente&ref=${orderRef}`,
        },
        auto_return: "approved",
      };

      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${perfil.mp_access_token}`,
        },
        body: JSON.stringify(mpBody),
      });

      const mpData = await mpRes.json();
      if (!mpData.init_point) throw new Error("Erro ao criar preferência no Mercado Pago");

      paymentUrl = mpData.init_point;

      // Salvar payment_id
      await supabase.from("vendas").update({ payment_id: mpData.id }).eq("id", vendaId);
    }

    // ─── INFINITEPAY ────────────────────────────────────────
    if (perfil.payment_gateway === "infinitepay") {
      if (!perfil.infinitepay_tag) throw new Error("InfiniteTag não configurada");

      const ipBody = {
        handle: perfil.infinitepay_tag,
        amount: Math.round(total * 100), // em centavos
        order_nsu: orderRef,
        redirect_url: `https://isabelapublicitaria-sys.github.io/docegestao/cardapio.html?pagamento=sucesso&ref=${orderRef}`,
        webhook_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/payment-webhook`,
        items: items.map((item: any) => ({
          description: item.nome,
          quantity: item.qty,
          price: Math.round(item.preco * 100),
        })),
        customer: {
          name: cliente_nome || "Cliente",
          phone: (cliente_tel || "").replace(/\D/g, ""),
        },
      };

      const ipRes = await fetch("https://api.checkout.infinitepay.io/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ipBody),
      });

      const ipData = await ipRes.json();
      if (!ipData.url) throw new Error("Erro ao criar link InfinitePay: " + JSON.stringify(ipData));

      paymentUrl = ipData.url;

      await supabase.from("vendas").update({ payment_id: orderRef }).eq("id", vendaId);
    }

    return new Response(
      JSON.stringify({ success: true, payment_url: paymentUrl, venda_id: vendaId, order_ref: orderRef }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
