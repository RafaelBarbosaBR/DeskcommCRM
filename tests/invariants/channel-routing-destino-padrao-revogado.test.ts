// #2837 / #2331 — o destino padrão do número sai junto com quem sai da equipe.
// Arquivo próprio porque tests/invariants/** existente é congelado (freeze-invariants);
// as fixtures são as mesmas de channel-routing.test.ts.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRoutingWorker } from "@/lib/routing/worker";
import { routingPgSupabase } from "../support/routing-pg-supabase";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
import { seedGov, GOV_ORG as org, GOV_AGENT_A as ana, GOV_AGENT_B as bruno, GOV_MANAGER as manager, GOV_SESSION as channel, GOV_CONV_UNASSIGNED as conv } from "./gov-helpers";
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 5 });
const query = (text: string, args: unknown[] = []) => pool.query(text, args);
async function asUser(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const result = await c.query(text, args); await c.query("commit"); return result;
  } catch (error) { await c.query("rollback"); throw error; } finally { c.release(); }
}
const disponibilizar = (user: string) =>
  query("insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule) values($1,$2,true,1,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=1,schedule='{}'", [org, user]);

beforeAll(() => seedGov());
afterAll(() => pool.end());

it("revogar o destino padrão solta o vínculo, e o número volta a distribuir pelo modo entre os responsáveis", async () => {
  await query("update conversations set assigned_to_user_id=null,assignee_kind=null,status='open' where organization_id=$1", [org]);
  await disponibilizar(ana); await disponibilizar(bruno);
  await query("update organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{routing}','{\"mode\":\"manual\"}') where id=$1", [org]);
  await asUser(manager, "select fn_set_channel_routing($1,$2,$3,false,$4,$5) result", [org, channel, [ana], "round_robin", bruno]);
  // Revogação é UPDATE (revoked_at), não DELETE: o ON DELETE SET NULL da FK não dispara.
  await query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [org, bruno]);
  const regra = await query("select default_assignee_user_id from channel_routing_policies where organization_id=$1 and channel_session_id=$2", [org, channel]);
  expect(regra.rows[0].default_assignee_user_id).toBeNull();
  await query("delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'", [org]);
  await query("select fn_request_channel_routing($1,$2)", [org, conv]);
  const adapter = routingPgSupabase(pool); vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
  const result = await runRoutingWorker({ now: new Date() });
  expect(result.outcomes.assigned).toBe(1);
  expect((await query("select assigned_to_user_id from conversations where organization_id=$1 and id=$2", [org, conv])).rows[0].assigned_to_user_id).toBe(ana);
});
