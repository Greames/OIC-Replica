"use client";

import { ATTRIBUTE_TYPES, type AttributeType } from "@oicr/semantic/types";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { addAttributeAction } from "../../actions";

export function AttributeForm({ entity }: { entity: string }) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<AttributeType>("string");
  const [description, setDescription] = useState("");
  const [identifier, setIdentifier] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_10rem_2fr]"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addAttributeAction(entity, {
            name,
            label: label || name,
            type,
            description,
            ...(identifier ? { identifier } : {}),
          });
          setResult(r);
          if (r.ok) {
            setName("");
            setLabel("");
            setDescription("");
            setIdentifier(false);
          }
        });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="attr-name">Name</Label>
        <Input id="attr-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="loyaltyTier" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="attr-label">Label</Label>
        <Input id="attr-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Loyalty tier" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="attr-type">Type</Label>
        <Select id="attr-type" value={type} onChange={(e) => setType(e.target.value as AttributeType)}>
          {ATTRIBUTE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="attr-description">Meaning</Label>
        <Input
          id="attr-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it holds; the AI uses this to bind fields."
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={identifier} onChange={(e) => setIdentifier(e.target.checked)} />
        Identifies the record across systems
      </label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-3 lg:justify-end">
        {result?.ok && (
          <p role="status" className="text-sm text-success">
            {result.message}
          </p>
        )}
        <FieldError>{result?.error}</FieldError>
        <Button type="submit" disabled={pending || !name}>
          {pending ? "Adding…" : "Add attribute"}
        </Button>
      </div>
    </form>
  );
}
