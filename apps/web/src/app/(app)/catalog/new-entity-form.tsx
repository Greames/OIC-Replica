"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import type { ActionResult } from "@/lib/errors";
import { createEntityAction } from "./actions";

export function NewEntityForm() {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResult(await createEntityAction({ name, label: label || name, description })));
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="entity-name">Name</Label>
        <Input id="entity-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ShipmentNotice" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="entity-label">Label</Label>
        <Input
          id="entity-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Shipment notice"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="entity-description">Description</Label>
        <Input
          id="entity-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="An advance shipping notice from a supplier."
        />
      </div>
      <Button type="submit" disabled={pending || !name}>
        {pending ? "Creating…" : "Create entity"}
      </Button>
      <div className="sm:col-span-4">
        <FieldError>{result?.fieldErrors?.name ?? result?.error}</FieldError>
      </div>
    </form>
  );
}
