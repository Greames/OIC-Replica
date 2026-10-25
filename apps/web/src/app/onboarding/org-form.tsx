"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldError, Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "team"}-${Math.random().toString(36).slice(2, 6)}`;
}

export function OrgForm({ defaultName }: { defaultName: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // onSubmit, not a form action: a failed attempt must keep what was typed.
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const name = String(form.get("name")).trim();
    const res = await authClient.organization.create({ name, slug: slugify(name) });
    if (res.error || !res.data) {
      setPending(false);
      setError(res.error?.message ?? "Could not create the workspace.");
      return;
    }
    await authClient.organization.setActive({ organizationId: res.data.id });
    router.push("/");
    router.refresh();
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold">Create your workspace</h1>
      <p className="mt-1 text-sm text-fg-muted">
        Your integrations, connections and runs live here. You can invite your team later.
      </p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Workspace name</Label>
          <Input id="name" name="name" defaultValue={defaultName} required maxLength={80} />
        </div>
        <FieldError>{error}</FieldError>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </Button>
      </form>
    </Card>
  );
}
