import type { FlowDocInput } from "@oicr/flow-schema";

/** Starting points for the JSON editor until the AI builder arrives. */
export function templatesFor(
  style: "scheduled" | "application",
  connections: string[],
): { name: string; doc: FlowDocInput }[] {
  const src = connections[0] ?? "source_api";
  const dst = connections[1] ?? connections[0] ?? "target_api";
  if (style === "scheduled") {
    return [
      {
        name: "Fetch records and send each one on",
        doc: {
          schemaVersion: 1,
          style: "scheduled",
          trigger: { id: "trigger", type: "schedule" },
          steps: [
            { id: "fetch", type: "invoke", label: "Fetch records", connection: src, operation: "GET /orders" },
            {
              id: "each",
              type: "forEach",
              over: "$fetch.body",
              as: "item",
              steps: [
                {
                  id: "guard",
                  type: "scope",
                  steps: [
                    {
                      id: "shape",
                      type: "map",
                      label: "Map fields",
                      expression: '{ "external_id": $item.id, "payload": $item }',
                    },
                    {
                      id: "send",
                      type: "invoke",
                      label: "Send record",
                      connection: dst,
                      operation: "POST /records",
                      request: '{ "body": $shape }',
                      retry: { attempts: 3, backoffSeconds: 5 },
                    },
                  ],
                  onFault: [
                    {
                      id: "note",
                      type: "log",
                      level: "warn",
                      message: "Record {{$item.id}} failed: {{$fault.message}}",
                    },
                  ],
                },
              ],
            },
          ],
          businessIds: [{ name: "first_id", expr: "$fetch.body[0].id", primary: true }],
        },
      },
    ];
  }
  return [
    {
      name: "Receive a request, forward it, answer the caller",
      doc: {
        schemaVersion: 1,
        style: "application",
        trigger: { id: "trigger", type: "http", method: "POST", path: "/", sync: true },
        steps: [
          {
            id: "shape",
            type: "map",
            label: "Map request",
            expression: '{ "name": $trigger.name, "email": $lowercase($trigger.email) }',
          },
          {
            id: "send",
            type: "invoke",
            label: "Forward",
            connection: dst,
            operation: "POST /contacts",
            request: '{ "body": $shape }',
          },
          { id: "reply", type: "return", status: 200, body: '{ "ok": true, "id": $send.body.id }' },
        ],
        businessIds: [{ name: "email", expr: "$trigger.email", primary: true }],
      },
    },
    {
      name: "Echo (no connections needed)",
      doc: {
        schemaVersion: 1,
        style: "application",
        trigger: { id: "trigger", type: "http", method: "POST", path: "/", sync: true },
        steps: [{ id: "reply", type: "return", status: 200, body: '{ "received": $trigger, "at": $now() }' }],
      },
    },
  ];
}
