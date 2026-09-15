"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useTeamInvites, type TeamInvite } from "@/hooks/team/useTeamInvites";
import { useResendInvite } from "@/hooks/team/useResendInvite";
import { useRevokeInvite } from "@/hooks/team/useRevokeInvite";
import { copyToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DotsThree } from "@/lib/ui/icons";

interface Props {
  /** `admin`: reenvia/copia/revoga. `manager`: só vê a lista. */
  canManage: boolean;
}

const STATUS_LABEL: Record<TeamInvite["status"], string> = {
  pending: "Pendente",
  accepted: "Aceito",
  expired: "Expirado",
  revoked: "Revogado",
};

const STATUS_VARIANT: Record<TeamInvite["status"], "outline" | "default" | "secondary" | "destructive"> = {
  pending: "outline",
  accepted: "default",
  expired: "secondary",
  revoked: "destructive",
};

export function TeamInvitesClient({ canManage }: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { data, isLoading, isError } = useTeamInvites();
  const resend = useResendInvite();
  const revoke = useRevokeInvite();
  const [revokeDialog, setRevokeDialog] = useState<TeamInvite | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError) return <p className="text-sm text-destructive">{t("Erro ao carregar convites.")}</p>;

  const invites = data?.data ?? [];
  if (invites.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("Nenhum convite enviado ainda.")}</p>;
  }

  async function copiarLink(invite: TeamInvite) {
    if (!invite.accept_url) return;
    await copyToClipboard(invite.accept_url);
    toast.success(t("Link copiado."));
  }

  async function reenviar(invite: TeamInvite) {
    try {
      const res = await resend.mutateAsync(invite.id);
      if (res.data.email_dispatched) {
        toast.success(t("Convite reenviado."));
      } else {
        // Instalação sem serviço de e-mail configurado: o link continua
        // sendo o caminho real, e dizer "enviado" seria mentir sobre algo
        // que a pessoa vai perceber que não chegou.
        toast.warning(t("O e-mail não saiu — copie o link e mande manualmente."));
        await copyToClipboard(res.data.accept_url);
      }
    } catch {
      /* showApiError já disparado pelo hook */
    }
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("E-mail")}</TableHead>
              <TableHead>{t("Papel")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Enviado em")}</TableHead>
              <TableHead>{t("Expira em")}</TableHead>
              {canManage ? <TableHead className="w-[80px]" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="font-medium">{i.email}</div>
                  {i.status === "pending" && !i.email_dispatched ? (
                    <div className="text-xs text-amber-600 dark:text-amber-500">
                      {t("O e-mail não saiu — copie o link e mande manualmente.")}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{i.role}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[i.status]}>{t(STATUS_LABEL[i.status])}</Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(i.invited_at).toLocaleString(tagDoIdioma)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(i.expires_at).toLocaleString(tagDoIdioma)}
                </TableCell>
                {canManage ? (
                  <TableCell>
                    {i.status === "pending" || i.status === "expired" ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={t("Ações")}>
                            <DotsThree size={20} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {i.status === "pending" && (
                            <DropdownMenuItem onClick={() => void copiarLink(i)}>
                              {t("Copiar link")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            disabled={resend.isPending}
                            onClick={() => void reenviar(i)}
                          >
                            {t("Reenviar")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setRevokeDialog(i)}
                          >
                            {t("Revogar")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!revokeDialog} onOpenChange={(o) => !o && setRevokeDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Revogar convite")}</DialogTitle>
            <DialogDescription>
              {revokeDialog?.email}{" "}
              {t(
                "não vai mais conseguir aceitar este convite, mesmo com o link ainda dentro da validade.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeDialog(null)}>
              {t("Cancelar")}
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={async () => {
                if (!revokeDialog) return;
                try {
                  await revoke.mutateAsync(revokeDialog.id);
                  toast.success(t("Convite revogado."));
                  setRevokeDialog(null);
                } catch {
                  /* showApiError já disparado pelo hook */
                }
              }}
            >
              {t("Revogar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
