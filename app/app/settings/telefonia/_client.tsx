"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface Api4comConnectionRow {
  organization_id: string;
  domain: string;
  account_email: string;
  status: "connecting" | "healthy" | "token_invalid" | "disconnected" | "error";
  last_webhook_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Api4comExtension {
  id: string;
  extension: string;
  name?: string;
}

interface MembroDto {
  user_id: string;
  email: string | null;
  full_name: string | null;
  extension: string | null;
}

const connectionKey = ["telefonia", "api4com", "connection"] as const;
const extensionsKey = ["telefonia", "api4com", "extensions"] as const;
const mappingsKey = ["telefonia", "api4com", "mappings"] as const;

function useConnection(initialData: Api4comConnectionRow | null) {
  return useQuery({
    queryKey: connectionKey,
    queryFn: async () => {
      const res = await apiClient.get<{ data: Api4comConnectionRow | null }>("/api/v1/telefonia/api4com");
      return res.data;
    },
    initialData,
  });
}

const STATUS_LABEL: Record<Api4comConnectionRow["status"], string> = {
  connecting: "Conectando…",
  healthy: "Conectado",
  token_invalid: "Token inválido — reconecte",
  disconnected: "Desconectado",
  error: "Erro",
};

function ContaApi4com({ connection, canWrite }: { connection: Api4comConnectionRow | null; canWrite: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: "", password: "", domain: "" });

  const conectar = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<{ data: Api4comConnectionRow }>("/api/v1/telefonia/api4com", form);
      return res.data;
    },
    onSuccess: (row) => {
      queryClient.setQueryData(connectionKey, row);
      setForm({ email: "", password: "", domain: "" });
    },
    onError: (err) => showApiError(err),
  });

  const desconectar = useMutation({
    mutationFn: async () => {
      await apiClient.delete("/api/v1/telefonia/api4com");
    },
    onSuccess: () => queryClient.setQueryData(connectionKey, null),
    onError: (err) => showApiError(err),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Conta api4com")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connection ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={connection.status === "healthy" ? "default" : "destructive"}>
                {t(STATUS_LABEL[connection.status])}
              </Badge>
              <span className="text-muted-foreground">
                {connection.account_email} · {connection.domain}
              </span>
            </div>
            {canWrite && (
              <Button
                variant="outline"
                className="w-fit"
                onClick={() => desconectar.mutate()}
                disabled={desconectar.isPending}
              >
                {desconectar.isPending ? t("Desconectando…") : t("Desconectar")}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("Nenhuma conta api4com conectada nesta organização ainda.")}
          </p>
        )}

        {canWrite && (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-sm font-medium">
              {t(connection ? "Trocar a conta conectada" : "Conectar uma conta")}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api4com-email">{t("E-mail da conta api4com")}</Label>
              <Input
                id="api4com-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api4com-password">{t("Senha")}</Label>
              <Input
                id="api4com-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api4com-domain">{t("Domínio")}</Label>
              <Input
                id="api4com-domain"
                placeholder="suaempresa.api4com.com"
                value={form.domain}
                onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "A senha não é guardada — ela é usada uma vez para gerar um acesso permanente, cifrado, e descartada.",
              )}
            </p>
            <Button
              className="w-fit"
              onClick={() => conectar.mutate()}
              disabled={conectar.isPending || !form.email || !form.password || !form.domain}
            >
              {conectar.isPending ? t("Conectando…") : t("Conectar")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RamaisDaEquipe({ conectado, canWrite }: { conectado: boolean; canWrite: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();

  const membros = useQuery({
    queryKey: mappingsKey,
    queryFn: async () => (await apiClient.get<{ data: MembroDto[] }>("/api/v1/telefonia/api4com/mapeamentos")).data,
    enabled: conectado,
  });
  const extensoes = useQuery({
    queryKey: extensionsKey,
    queryFn: async () =>
      (await apiClient.get<{ data: Api4comExtension[] }>("/api/v1/telefonia/api4com/extensoes")).data,
    enabled: conectado && canWrite,
  });

  const salvar = useMutation({
    mutationFn: async (input: { user_id: string; extension: string | null }) => {
      await apiClient.put("/api/v1/telefonia/api4com/mapeamentos", input);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mappingsKey }),
    onError: (err) => showApiError(err),
  });

  if (!conectado) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Ramais da equipe")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("Cada pessoa que vai discar pelo CRM precisa de um ramal já existente na conta api4com.")}
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Pessoa")}</TableHead>
              <TableHead>{t("Ramal")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(membros.data ?? []).map((m) => (
              <TableRow key={m.user_id}>
                <TableCell>{m.full_name ?? m.email ?? m.user_id}</TableCell>
                <TableCell>
                  {canWrite ? (
                    <Select
                      value={m.extension ?? "__nenhum__"}
                      onValueChange={(v) =>
                        salvar.mutate({ user_id: m.user_id, extension: v === "__nenhum__" ? null : v })
                      }
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder={t("Sem ramal")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__nenhum__">{t("Sem ramal")}</SelectItem>
                        {(extensoes.data ?? []).map((e) => (
                          <SelectItem key={e.id} value={e.extension}>
                            {e.extension}
                            {e.name ? ` — ${e.name}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-sm text-muted-foreground">{m.extension ?? t("Sem ramal")}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function TelefoniaSettingsClient({
  initialData,
  canWrite,
}: {
  initialData: Api4comConnectionRow | null;
  canWrite: boolean;
}) {
  const { data: connection } = useConnection(initialData);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <ContaApi4com connection={connection ?? null} canWrite={canWrite} />
      <RamaisDaEquipe conectado={connection?.status === "healthy"} canWrite={canWrite} />
    </div>
  );
}
