// Semantic functions: expressions read and write business data through the
// Semantic Catalog instead of each system's technical field names.
//   $toSemantic($get.body.items, "oracle-ebs", "HZ_CUST_ACCOUNTS")       → Customer records
//   $fromSemantic($customer, "netsuite", "customer")                        → a NetSuite customer
//   $translate($get.body, "oracle-ebs", "HZ_CUST_ACCOUNTS", "netsuite", "customer")
// The system and object arguments must be literal strings: activation resolves
// them against the tenant's bindings and pins the result in the execution plan.

export const SEMANTIC_FUNCTIONS = {
  toSemantic: { objects: 1, usage: '$toSemantic(value, "system", "object")' },
  fromSemantic: { objects: 1, usage: '$fromSemantic(value, "system", "object")' },
  translate: { objects: 2, usage: '$translate(value, "from system", "from object", "to system", "to object")' },
} as const;

export type SemanticFunction = keyof typeof SEMANTIC_FUNCTIONS;

export const isSemanticFunction = (name: unknown): name is SemanticFunction =>
  typeof name === "string" && Object.hasOwn(SEMANTIC_FUNCTIONS, name);

/** One system object, e.g. { system: "oracle-ebs", object: "HZ_CUST_ACCOUNTS" }. */
export interface SemanticObjectRef {
  system: string;
  object: string;
}

/** A semantic function call found in an expression. */
export interface SemanticCall {
  fn: SemanticFunction;
  /** The objects it names, in argument order; empty when `dynamic`. */
  objects: SemanticObjectRef[];
  /** Arguments that must be literal strings are not. */
  dynamic?: boolean;
  /** Wrong number of arguments. */
  arity?: boolean;
}

export const semanticKey = (ref: SemanticObjectRef) => `${ref.system}/${ref.object}`;

export function parseSemanticKey(key: string): SemanticObjectRef {
  const i = key.indexOf("/");
  return { system: key.slice(0, i), object: key.slice(i + 1) };
}
