"use server";

import { headers } from "next/headers";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { semSmtpNaInstalacao } from "@/lib/email/estado";

export type RequestPasswordResetResult =
  | { ok: true }
  | {
      ok: false;
      error: "validation_error" | "rate_limited" | "smtp_not_configured" | "request_failed";
      details?: Record<string, unknown>;
    };

/**
 * Pede o e-mail de redefinição de senha. Resposta neutra quanto à existência
 * do e-mail (o GoTrue responde 200 para e-mail desconhecido — não vaza nada);
 * erros aqui são só de infra (SMTP, rate limit).
 */
export async function requestPasswordReset(
  input: ForgotPasswordInput,
): Promise<RequestPasswordResetResult> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const hdrs = await headers();
  const origin = hdrs.get("origin") ?? env.NEXT_PUBLIC_APP_URL;
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Sem teto, este endpoint é uma metralhadora de e-mail contra terceiros e um
  // oráculo de enumeração de conta. Issue #64.
  if (await authRateLimited("reset", parsed.data.email, AUTH_LIMITS.reset)) {
    return { ok: false, error: "rate_limited" };
  }

  // #2755 — decidido ANTES de chamar o GoTrue, sem olhar o que ele responde:
  // assim a resposta depende só da instalação, nunca do e-mail digitado. A
  // régua é compartilhada com quem AVISA (o painel de atualização), em
  // `lib/email/estado.ts`.
  if (await semSmtpNaInstalacao()) return { ok: false, error: "smtp_not_configured" };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    // ?type=recovery sobrevive ao redirect do GoTrue (preserva query string
    // existente ao anexar `code=`/`token_hash=`) — sem SMTP customizado o
    // Supabase usa o template padrão dele, que só devolve `code` (PKCE), sem
    // `type`; /auth/confirm depende deste param pra saber que é recovery.
    redirectTo: `${origin}/auth/confirm?type=recovery`,
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };
    await audit({
      action: "auth.password_reset_request_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error.message,
      },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "request_failed" };
  }

  await audit({
    action: "auth.password_reset_requested",
    metadata: { email_hash: hashEmail(parsed.data.email) },
    requestId,
    ip,
    userAgent,
  });

  return { ok: true };
}
