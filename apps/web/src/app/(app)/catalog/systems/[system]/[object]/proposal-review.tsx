"use client";

import { Check, Sparkles, X } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { decideProposalAction, saveObjectAction } from "../../../actions";

interface Item {
  field: string;
  attribute: string;
  confidence: number;
  evidence: string;
  read?: string;
  write?: string;
  conflict?: string;
  decision: "pending" | "approved" | "auto_approved" | "rejected";
}

interface Proposal {
  id: string;
  system: string;
  object: string;
  entity: string;
  entityConfidence: number;
  reasoning: string;
  model: string;
  createdAt: string;
  items: Item[];
  unmapped: { field: string; reason: string }[];
  dropped: { field: string; attribute: string; reason: string }[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Confidence({ value }: { value: number }) {
  const tone = value >= 0.9 ? "bg-success" : value >= 0.6 ? "bg-accent" : "bg-danger";
  return (
    <span className="inline-flex items-center gap-2" title={`Confidence ${pct(value)}`}>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full", tone)} style={{ width: pct(value) }} />
      </span>
      <span className="text-xs tabular-nums">{pct(value)}</span>
    </span>
  );
}

const DECISION_LABEL: Record<Item["decision"], string> = {
  pending: "to review",
  approved: "approved",
  auto_approved: "applied",
  rejected: "rejected",
};

export function ProposalReview({
  proposal,
  objectEntity,
  attributes,
  canBuild,
}: {
  proposal: Proposal;
  objectEntity: string;
  attributes: { name: string; label: string }[];
  canBuild: boolean;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const { system, object } = proposal;
  const waiting = proposal.items.filter((i) => i.decision === "pending");
  const entityMismatch = objectEntity !== proposal.entity;
  const decide = (decisions: { field: string; decision: "approve" | "reject" }[]) =>
    start(async () =>
      setResult(
        await decideProposalAction(
          proposal.id,
          system,
          object,
          decisions.map((d) => (d.decision === "approve" && edits[d.field] ? { ...d, attribute: edits[d.field] } : d)),
        ),
      ),
    );
  const confident = waiting.filter((i) => i.confidence >= 0.9);

  return (
    <Card className="mb-6 border-accent/40 p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4 text-accent" aria-hidden /> AI proposal: {object} holds {proposal.entity}{" "}
            records
            <Confidence value={proposal.entityConfidence} />
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {proposal.model} · {new Date(proposal.createdAt).toLocaleString()} · {waiting.length} of{" "}
            {proposal.items.length} to review
          </p>
          {proposal.reasoning && <p className="mt-2 text-sm">{proposal.reasoning}</p>}
        </div>
        {canBuild && waiting.length > 0 && !entityMismatch && (
          <div className="flex flex-wrap gap-2">
            {confident.length > 0 && confident.length < waiting.length && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => decide(confident.map((i) => ({ field: i.field, decision: "approve" })))}
              >
                Approve {confident.length} at 90%+
              </Button>
            )}
            <Button
              disabled={pending}
              onClick={() => decide(waiting.map((i) => ({ field: i.field, decision: "approve" })))}
            >
              <Check aria-hidden /> Approve all
            </Button>
          </div>
        )}
      </div>

      {entityMismatch && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-sm">
          <span>
            {object} is bound to {objectEntity}; the AI thinks it holds {proposal.entity}.
          </span>
          {canBuild && (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                start(async () => setResult(await saveObjectAction({ system, object, entity: proposal.entity })))
              }
            >
              Bind to {proposal.entity}
            </Button>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-fg-muted">
            <tr>
              <th className="py-2 pr-4 font-medium">Field</th>
              <th className="py-2 pr-4 font-medium">Attribute</th>
              <th className="py-2 pr-4 font-medium">Confidence</th>
              <th className="py-2 pr-4 font-medium">Why</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {proposal.items.map((i) => (
              <tr key={i.field} className={cn(i.decision !== "pending" && "text-fg-muted")}>
                <td className="py-2 pr-4 align-top font-mono">{i.field}</td>
                <td className="py-2 pr-4 align-top">
                  {i.decision === "pending" && canBuild && !entityMismatch ? (
                    <Select
                      aria-label={`Attribute for ${i.field}`}
                      className="h-8 w-44"
                      value={edits[i.field] ?? i.attribute}
                      onChange={(e) => setEdits((x) => ({ ...x, [i.field]: e.target.value }))}
                    >
                      {attributes.map((a) => (
                        <option key={a.name} value={a.name}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="font-mono">{i.attribute}</span>
                  )}
                  {(i.read || i.write) && (
                    <div className="mt-1 font-mono text-xs text-fg-muted">
                      {i.read && <div>read: {i.read}</div>}
                      {i.write && <div>write: {i.write}</div>}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-4 align-top">
                  <Confidence value={i.confidence} />
                </td>
                <td className="py-2 pr-4 align-top">
                  <div>{i.evidence}</div>
                  {i.conflict && <div className="mt-1 text-xs text-danger">{i.conflict}</div>}
                </td>
                <td className="py-2 align-top whitespace-nowrap text-right">
                  {i.decision === "pending" && canBuild && !entityMismatch ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Approve ${i.field}`}
                        disabled={pending}
                        onClick={() => decide([{ field: i.field, decision: "approve" }])}
                      >
                        <Check aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Reject ${i.field}`}
                        disabled={pending}
                        onClick={() => decide([{ field: i.field, decision: "reject" }])}
                      >
                        <X aria-hidden />
                      </Button>
                    </>
                  ) : (
                    <Badge>{DECISION_LABEL[i.decision]}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(proposal.unmapped.length > 0 || proposal.dropped.length > 0) && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-fg-muted">
            {proposal.unmapped.length} field(s) left unbound
            {proposal.dropped.length > 0 && `, ${proposal.dropped.length} proposal(s) refused by the checks`}
          </summary>
          <ul className="mt-2 space-y-1 text-fg-muted">
            {proposal.unmapped.map((u) => (
              <li key={`u-${u.field}`}>
                <span className="font-mono">{u.field}</span>: {u.reason}
              </li>
            ))}
            {proposal.dropped.map((d) => (
              <li key={`d-${d.field}-${d.attribute}`}>
                <span className="font-mono">
                  {d.field} → {d.attribute}
                </span>
                : {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={`mt-3 text-sm ${result.ok ? "text-success" : "text-danger"}`}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </Card>
  );
}
