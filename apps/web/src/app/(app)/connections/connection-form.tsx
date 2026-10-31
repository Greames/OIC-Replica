"use client";

import type { AuthType, Field } from "@oicr/adapters";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldError, Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { saveConnectionAction } from "./actions";

const AUTH_LABELS: Record<AuthType, string> = {
  none: "No authentication",
  basic: "Basic (username + password)",
  api_key: "API key in a header",
  bearer: "Bearer token",
};

export interface ConnectionFormProps {
  adapter: { id: string; name: string; fields: Field[]; authTypes: AuthType[]; roles: string[] };
  projects: { id: string; name: string }[];
  initial?: {
    id: string;
    name: string;
    identifier: string;
    projectId: string | null;
    role: string;
    authType: AuthType;
    properties: Record<string, unknown>;
    hasSecret: boolean;
  };
}

function headersText(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  return Object.entries(v as Record<string, string>)
    .map(([k, val]) => `${k}: ${val}`)
    .join("\n");
}

export function ConnectionForm({ adapter, projects, initial }: ConnectionFormProps) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(saveConnectionAction, {});
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? adapter.authTypes[0] ?? "none");
  const err = (k: string) => state.fieldErrors?.[k];
  const visible = adapter.fields.filter((f) => !f.authTypes || f.authTypes.includes(authType));
  const general = visible.filter((f) => !f.authTypes);
  const auth = visible.filter((f) => f.authTypes);

  const field = (f: Field) => {
    const id = `f-${f.key}`;
    const value = initial?.properties[f.key];
    return (
      <div key={f.key} className="flex flex-col gap-1.5">
        <Label htmlFor={id}>
          {f.label}
          {f.required && <span className="text-danger"> *</span>}
        </Label>
        {f.type === "select" ? (
          <Select
            id={id}
            name={f.key}
            defaultValue={value === undefined ? (f.options?.[0]?.value ?? "") : String(value)}
          >
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : f.type === "keyvalue" ? (
          <Textarea
            id={id}
            name={f.key}
            defaultValue={headersText(value)}
            placeholder="Header-Name: value"
            className="font-mono text-xs"
          />
        ) : (
          <Input
            id={id}
            name={f.key}
            type={
              f.type === "password" ? "password" : f.type === "number" ? "number" : f.type === "url" ? "url" : "text"
            }
            defaultValue={f.secret ? "" : value === undefined ? "" : String(value)}
            placeholder={f.secret && initial?.hasSecret ? "Stored. Leave blank to keep it." : f.placeholder}
            required={f.required && !(f.secret && initial?.hasSecret)}
            autoComplete={f.secret ? "new-password" : "off"}
          />
        )}
        {f.help && <p className="text-xs text-fg-muted">{f.help}</p>}
        <FieldError>{err(f.key)}</FieldError>
      </div>
    );
  };

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="adapter" value={adapter.id} />
      {initial && <input type="hidden" name="id" value={initial.id} />}

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">
            Name<span className="text-danger"> *</span>
          </Label>
          <Input id="name" name="name" defaultValue={initial?.name} placeholder="Shop API" required maxLength={100} />
          <FieldError>{err("name")}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="identifier">Identifier</Label>
          <Input
            id="identifier"
            name="identifier"
            defaultValue={initial?.identifier}
            disabled={Boolean(initial)}
            placeholder="shop_api (from the name if blank)"
            className="font-mono"
          />
          <p className="text-xs text-fg-muted">Integrations refer to the connection by this. It cannot change later.</p>
          <FieldError>{err("identifier")}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="role">Used as</Label>
          <Select id="role" name="role" defaultValue={initial?.role ?? "invoke"}>
            <option value="invoke">Invoke: integrations call it</option>
            {adapter.roles.includes("trigger") && (
              <>
                <option value="trigger">Trigger: it calls integrations</option>
                <option value="trigger_invoke">Both</option>
              </>
            )}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="projectId">Project</Label>
          <Select id="projectId" name="projectId" defaultValue={initial?.projectId ?? ""}>
            <option value="">Shared by all projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <h2 className="font-medium sm:col-span-2">Endpoint</h2>
        {general.map(field)}
      </Card>

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <h2 className="font-medium sm:col-span-2">Security</h2>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="authType">Authentication</Label>
          <Select
            id="authType"
            name="authType"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as AuthType)}
          >
            {adapter.authTypes.map((t) => (
              <option key={t} value={t}>
                {AUTH_LABELS[t]}
              </option>
            ))}
          </Select>
          <p className="text-xs text-fg-muted">
            Credentials are encrypted and never shown again, not even to the AI builder.
          </p>
        </div>
        {auth.map(field)}
      </Card>

      <FieldError>{state.error && !state.fieldErrors ? state.error : null}</FieldError>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : initial ? "Save changes" : "Create connection"}
        </Button>
      </div>
    </form>
  );
}
