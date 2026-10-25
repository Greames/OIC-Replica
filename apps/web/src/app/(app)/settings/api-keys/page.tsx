import { can, listApiKeys } from "@oicr/db";
import { Badge, Card } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { KeyForm } from "./key-form";
import { RevokeButton } from "./revoke-button";

export const metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  const viewer = await requireViewer();
  if (!can(viewer.role, "admin"))
    return <Card className="p-5 text-sm text-fg-muted">Only admins manage API keys.</Card>;
  const keys = await listApiKeys(db, viewer);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-muted">
        Keys let scripts and agents (like Hermes Agent, over MCP) use this workspace. Send them as{" "}
        <code>Authorization: Bearer …</code>. A key can never manage members, channels or other keys.
      </p>
      {keys.length > 0 && (
        <Card className="divide-y divide-border" aria-label="API keys">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{k.name}</span>
                  <code className="font-mono text-xs text-fg-muted">oicr_{k.prefix}_…</code>
                  {k.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                  {k.revokedAt && <Badge className="bg-danger/15 text-danger">revoked</Badge>}
                </div>
                <div className="text-xs text-fg-muted">
                  Created {k.createdAt.toLocaleDateString()} ·{" "}
                  {k.lastUsedAt ? `last used ${k.lastUsedAt.toLocaleString()}` : "never used"}
                </div>
              </div>
              {!k.revokedAt && <RevokeButton id={k.id} />}
            </div>
          ))}
        </Card>
      )}
      <Card className="p-5">
        <h2 className="mb-4 font-medium">Create a key</h2>
        <KeyForm />
      </Card>
    </div>
  );
}
