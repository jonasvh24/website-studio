'use strict';
/**
 * PayPal order verification. Optional: needs the REST app's Client ID and
 * Secret in config.local.json → paypal: { clientId, clientSecret, sandbox }.
 * verifyPayment(config, payment) → { verified, status, amount, currency, reason }
 */

function creds(config) {
  const p = config.paypal || {};
  return {
    id: p.clientId || process.env.PAYPAL_CLIENT_ID || '',
    secret: p.clientSecret || process.env.PAYPAL_CLIENT_SECRET || '',
    sandbox: p.sandbox === true || process.env.PAYPAL_SANDBOX === '1'
  };
}

function isConfigured(config) {
  const c = creds(config);
  return !!(c.id && c.secret);
}

async function token(config, sandbox) {
  const c = creds(config);
  const base = sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`PayPal auth HTTP ${res.status}`);
  return { base, access: (await res.json()).access_token };
}

async function verifyPayment(config, payment, expected = {}) {
  if (!payment || !payment.orderId) return { verified: false, reason: 'No order id' };
  if (!isConfigured(config)) return { verified: null, reason: 'PayPal credentials not configured' };
  const sandbox = payment.sandbox === true || creds(config).sandbox;
  const { base, access } = await token(config, sandbox);
  const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(payment.orderId)}`, {
    headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000)
  });
  if (res.status === 404) return { verified: false, reason: 'Order not found at PayPal' };
  if (!res.ok) throw new Error(`PayPal order HTTP ${res.status}`);
  const order = await res.json();
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
  const status = cap?.status || order.status;
  const amount = cap?.amount?.value || order.purchase_units?.[0]?.amount?.value;
  const currency = cap?.amount?.currency_code || order.purchase_units?.[0]?.amount?.currency_code;
  let reason = '';
  if (status !== 'COMPLETED') reason = `Status is ${status}`;
  else if (expected.amount && Number(amount) < Number(expected.amount)) reason = `Amount ${amount} is below ${expected.amount}`;
  else if (expected.currency && currency !== expected.currency) reason = `Currency ${currency} is not ${expected.currency}`;
  return { verified: !reason, status, amount, currency, reason, payerEmail: order.payer?.email_address || '', sandbox };
}

module.exports = { verifyPayment, isConfigured };
