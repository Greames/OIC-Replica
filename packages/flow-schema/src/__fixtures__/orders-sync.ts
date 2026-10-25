/** The architecture doc's example: scheduled DB → REST with a fault handler. */
export const ordersSync = {
  schemaVersion: 1,
  style: "scheduled",
  trigger: { id: "t1", type: "schedule" },
  variables: { lastRun: { type: "string", initial: "1970-01-01T00:00:00Z" } },
  steps: [
    {
      id: "n1",
      type: "invoke",
      label: "Read new orders",
      connection: "orders_db",
      operation: "query",
      config: { sql: "select * from orders where created_at > :since" },
      request: '{ "params": { "since": $vars.lastRun } }',
    },
    {
      id: "n2",
      type: "forEach",
      over: "$n1.rows",
      as: "order",
      steps: [
        {
          id: "n3",
          type: "scope",
          steps: [
            {
              id: "n4",
              type: "map",
              expression: '{ "external_id": $order.id, "total_cents": $round($order.total * 100) }',
            },
            {
              id: "n5",
              type: "invoke",
              connection: "shop_api",
              operation: "POST /orders",
              request: '{ "body": $n4 }',
              retry: { attempts: 3 },
            },
          ],
          onFault: [
            {
              id: "n6",
              type: "notify",
              to: ["ops@example.com"],
              subject: "Order {{$order.id}} failed",
              body: "{{$fault.message}}",
            },
          ],
        },
      ],
    },
    { id: "n7", type: "assign", assignments: [{ variable: "lastRun", value: "$now()" }] },
  ],
  businessIds: [{ name: "order", expr: "$n1.rows[0].id", primary: true }],
};

export const connections = {
  orders_db: { role: "invoke", adapter: "postgres" },
  shop_api: { role: "invoke", adapter: "rest" },
  inbound: { role: "trigger", adapter: "rest" },
} as const;
