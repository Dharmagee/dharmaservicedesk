import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";
import * as desk from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "dsd_session";

function tokenFrom(request: Request): string | undefined {
  const header = request.headers.get("cookie") || "";
  const match = header.match(/(?:^|;\s*)dsd_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function json(body: unknown, status = 200, extra?: (response: NextResponse) => void) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  extra?.(response);
  return response;
}

function setSession(response: NextResponse, token: string) {
  response.cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

function clearSession(response: NextResponse) {
  response.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function run(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const method = request.method;
  const { path } = await context.params;
  const parts = path ?? [];
  const url = new URL(request.url);
  if (method !== "GET" && method !== "HEAD") {
    if (request.headers.get("x-requested-with") !== "DharmaServiceDesk") {
      return json({ error: "This request was blocked." }, 403);
    }
  }
  try {
    const token = tokenFrom(request);
    const body = await readBody(request);
    const key = `${method} ${parts.join("/")}`;

    if (key === "GET health") return json({ ok: true, product: "Dharma Service Desk" });
    if (key === "GET meta") return json(await desk.meta());
    if (key === "POST auth/login") {
      const result = await desk.login(body.email, body.password);
      if ("token" in result) {
        return json({ user: result.user }, 200, (response) => setSession(response, result.token));
      }
      return json({ error: result.error }, result.status);
    }
    if (key === "POST auth/logout") {
      await desk.logout(token);
      return json({ ok: true }, 200, clearSession);
    }
    if (key === "GET session") return json(await desk.session(token));
    if (key === "POST auth/acknowledge") return json(await desk.acknowledge(token));
    if (key === "POST account/password") return json(await desk.changePassword(token, body.current, body.next));
    if (key === "GET tickets/export") {
      const file = await desk.exportIncidents(token, url.searchParams);
      return new NextResponse(new Uint8Array(file.bytes), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (key === "GET tickets") return json(await desk.listTickets(token, url.searchParams));
    if (method === "POST" && parts[0] === "tickets" && parts.length === 1) return json(await desk.createTicket(token, body));
    if (method === "GET" && parts[0] === "tickets" && parts.length === 2) return json(await desk.getTicket(token, parts[1]));
    if (method === "PATCH" && parts[0] === "tickets" && parts.length === 2) return json(await desk.updateTicket(token, parts[1], body));
    if (method === "DELETE" && parts[0] === "tickets" && parts.length === 2) return json(await desk.deleteTicket(token, parts[1], body));
    if (method === "POST" && parts[0] === "tickets" && parts[2] === "notes") return json(await desk.addNote(token, parts[1], body));
    if (method === "POST" && parts[0] === "tickets" && parts[2] === "phi") return json(await desk.revealPhi(token, parts[1], body, "ticket"));
    if (method === "POST" && parts[0] === "tickets" && parts[2] === "break-glass") return json(await desk.breakGlass(token, parts[1], body));
    if (method === "POST" && parts[0] === "tickets" && parts[2] === "export") return json(await desk.exportPhi(token, parts[1], body));
    if (method === "POST" && parts[0] === "tickets" && parts[2] === "approval") return json(await desk.decideApproval(token, parts[1], body));
    if (key === "GET knowledge") return json(await desk.listKnowledge(token));
    if (key === "POST knowledge") return json(await desk.saveKnowledge(token, undefined, body));
    if (method === "PATCH" && parts[0] === "knowledge" && parts.length === 2) return json(await desk.saveKnowledge(token, parts[1], body));
    if (method === "POST" && parts[0] === "knowledge" && parts[2] === "phi") return json(await desk.revealPhi(token, parts[1], body, "knowledge"));
    if (key === "GET cmdb") return json(await desk.listCmdb(token));
    if (key === "POST cmdb") return json(await desk.saveCmdb(token, undefined, body));
    if (method === "PATCH" && parts[0] === "cmdb" && parts.length === 2) return json(await desk.saveCmdb(token, parts[1], body));
    if (key === "POST catalog/request") return json(await desk.requestCatalog(token, body));
    if (key === "GET reports") return json(await desk.reports(token));
    if (key === "GET hipaa") return json(await desk.hipaa(token));
    if (key === "POST audit/export") return json(await desk.auditCsv(token));
    if (key === "GET search") return json(await desk.search(token, url.searchParams.get("q") || ""));
    if (key === "POST notifications") return json(await desk.markNotifications(token, body));
    if (key === "GET settings") return json(await desk.getSettings(token));
    if (key === "PUT settings") return json(await desk.saveSettings(token, body));
    if (key === "GET users") return json(await desk.listUsers(token));
    if (key === "POST users") return json(await desk.saveUser(token, undefined, body));
    if (method === "PATCH" && parts[0] === "users" && parts.length === 2) return json(await desk.saveUser(token, parts[1], body));
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error(error);
    return json({ error: "The desk could not complete that request." }, 500);
  }
}

export const GET = run;
export const POST = run;
export const PATCH = run;
export const PUT = run;
export const DELETE = run;
