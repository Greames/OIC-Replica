import type { Attribute, AttributeType, Entity } from "./catalog.js";

// The platform catalog: the business entities mid-market ERP integrations
// move, with attributes in one standard form (ISO dates and currency codes,
// JSON booleans and numbers). Workspaces add attributes and entities of their own.

export const CATALOG_VERSION = "2026.10";

const a = (
  name: string,
  type: AttributeType,
  label: string,
  description: string,
  more: Partial<Omit<Attribute, "name" | "type" | "label" | "description">> = {},
): Attribute => ({ name, type, label, description, ...more });

const number = (what: string, synonyms: string[]) =>
  a("number", "string", `${what} number`, `The business key people use for the ${what.toLowerCase()}.`, {
    identifier: true,
    required: true,
    synonyms,
  });
const currency = a("currency", "currency", "Currency", "ISO 4217 code of the document currency, e.g. USD.", {
  synonyms: ["currency code", "transactional currency", "document currency"],
});
const updatedAt = a("updatedAt", "datetime", "Last updated", "When the record last changed in its system.", {
  synonyms: ["last update date", "last modified", "changed on"],
});
const createdAt = a("createdAt", "datetime", "Created", "When the record was created in its system.", {
  synonyms: ["creation date", "date created"],
});
const active = a("active", "boolean", "Active", "Whether the record can be used in new transactions.", {
  synonyms: ["enabled", "status", "inactive (inverted)", "blocked (inverted)"],
});
const businessUnit = a(
  "businessUnit",
  "string",
  "Business unit",
  "The business unit, operating unit or company code that owns the document.",
  { synonyms: ["operating unit", "company code", "subsidiary", "org"] },
);
const party = (name: string, ref: "Customer" | "Supplier", label: string) =>
  a(name, "string", label, `Number of the ${ref.toLowerCase()} (its ${ref}.number).`, {
    references: ref,
    synonyms: ref === "Customer" ? ["sold to", "bill to", "buyer", "account"] : ["vendor", "invoicing party", "seller"],
  });
const amount = (name: string, label: string, description: string, synonyms: string[] = []) =>
  a(name, "number", label, description, { synonyms });
const date = (name: string, label: string, description: string, synonyms: string[] = []) =>
  a(name, "date", label, description, { synonyms });

const entity = (name: string, label: string, description: string, attributes: Attribute[]): Entity => ({
  name,
  label,
  description,
  attributes,
  origin: "platform",
});

export const PLATFORM_ENTITIES: Entity[] = [
  entity("Customer", "Customer", "A party the business sells to: a customer account.", [
    number("Customer", ["account number", "customer number", "customer id", "party number"]),
    a("name", "string", "Name", "Legal or trading name.", {
      required: true,
      synonyms: ["account name", "company name"],
    }),
    a("alternateName", "string", "Alternate name", "Another name, e.g. in a second script or a short name."),
    active,
    a("email", "email", "Email", "Main email address."),
    a("phone", "string", "Phone", "Main phone number."),
    currency,
    a("taxRegistrationNumber", "string", "Tax registration number", "VAT, GST or taxpayer id.", {
      synonyms: ["tax id", "vat number", "taxpayer id"],
    }),
    a("customerClass", "string", "Customer class", "Classification or account group.", {
      synonyms: ["customer class code", "account group", "category"],
    }),
    createdAt,
    updatedAt,
  ]),
  entity("Supplier", "Supplier", "A party the business buys from.", [
    number("Supplier", ["vendor number", "supplier number", "vendor id"]),
    a("name", "string", "Name", "Legal or trading name.", {
      required: true,
      synonyms: ["vendor name", "company name"],
    }),
    a("alternateName", "string", "Alternate name", "Another name, e.g. in a second script or a short name."),
    active,
    a("email", "email", "Email", "Main email address."),
    a("phone", "string", "Phone", "Main phone number."),
    currency,
    a("taxRegistrationNumber", "string", "Tax registration number", "VAT, GST or taxpayer id.", {
      synonyms: ["tax id", "taxpayer id", "1099 number"],
    }),
    a("supplierType", "string", "Supplier type", "Classification or account group.", {
      synonyms: ["vendor type", "account group"],
    }),
    createdAt,
    updatedAt,
  ]),
  entity("Item", "Item", "A product or service that is bought, sold or stocked.", [
    number("Item", ["item number", "sku", "product", "part number", "material"]),
    a("description", "string", "Description", "Short description.", { synonyms: ["display name", "item name"] }),
    a("uom", "string", "Unit of measure", "Primary or base unit of measure code.", {
      synonyms: ["primary uom", "base unit", "unit"],
    }),
    a("itemType", "string", "Item type", "The system's item or product type."),
    a("status", "string", "Status", "Item status code."),
    active,
    a("organization", "string", "Inventory organization", "Code of the organization the item record belongs to."),
    updatedAt,
  ]),
  entity("SalesOrder", "Sales order", "A customer's order.", [
    number("Sales order", ["order number", "sales document", "tran id"]),
    party("customer", "Customer", "Customer"),
    date("orderDate", "Order date", "Date the order was placed.", ["ordered date", "transaction date"]),
    currency,
    a("status", "string", "Status", "The system's order status code."),
    a("customerPoNumber", "string", "Customer PO number", "The customer's own reference for the order.", {
      synonyms: ["purchase order by customer", "cust po number", "other reference"],
    }),
    amount("totalAmount", "Total amount", "Order total in the document currency.", ["total net amount", "total"]),
    updatedAt,
  ]),
  entity("PurchaseOrder", "Purchase order", "An order the business places with a supplier.", [
    number("Purchase order", ["po number", "order number", "segment1"]),
    party("supplier", "Supplier", "Supplier"),
    date("orderDate", "Order date", "Date the order was created.", ["purchase order date", "creation date"]),
    currency,
    a("status", "string", "Status", "Approval or processing status code."),
    a("orderType", "string", "Order type", "Standard, blanket, contract...", { synonyms: ["document style"] }),
    a("buyer", "string", "Buyer", "Name of the buyer responsible."),
    businessUnit,
    updatedAt,
  ]),
  entity("Invoice", "Customer invoice", "A receivables invoice sent to a customer.", [
    number("Invoice", ["transaction number", "trx number", "billing document"]),
    party("customer", "Customer", "Bill-to customer"),
    date("invoiceDate", "Invoice date", "Date of the invoice.", ["transaction date", "billing date"]),
    date("dueDate", "Due date", "Date payment is due."),
    currency,
    amount("totalAmount", "Total amount", "Invoice total in the document currency."),
    a("transactionType", "string", "Transaction type", "Invoice, credit memo, debit memo..."),
    businessUnit,
    updatedAt,
  ]),
  entity("SupplierInvoice", "Supplier invoice", "A payables invoice received from a supplier.", [
    number("Supplier invoice", ["invoice num", "supplier's invoice number", "reference"]),
    a("documentNumber", "string", "Document number", "The receiving system's own number for the invoice."),
    party("supplier", "Supplier", "Supplier"),
    date("invoiceDate", "Invoice date", "Date on the supplier's invoice.", ["document date"]),
    date("dueDate", "Due date", "Date payment is due."),
    currency,
    amount("totalAmount", "Total amount", "Invoice total including tax.", ["invoice amount", "gross amount"]),
    a("invoiceType", "string", "Invoice type", "Standard, credit memo, prepayment..."),
    a("fiscalYear", "string", "Fiscal year", "Fiscal year the document number belongs to."),
    businessUnit,
    updatedAt,
  ]),
  entity("Payment", "Customer payment", "Money received from a customer (a receipt).", [
    number("Receipt", ["receipt number", "payment number"]),
    party("customer", "Customer", "Paying customer"),
    date("receiptDate", "Receipt date", "Date the payment was received."),
    amount("amount", "Amount", "Amount received in the payment currency.", ["payment amount"]),
    currency,
    a("method", "string", "Payment method", "Receipt method, e.g. wire or check."),
    a("status", "string", "Status", "The system's receipt status code."),
    businessUnit,
    updatedAt,
  ]),
  entity("JournalEntry", "Journal entry", "A general ledger journal.", [
    number("Journal", ["document number", "doc sequence value", "tran id"]),
    a("name", "string", "Name", "Journal name."),
    a("description", "string", "Description", "What the journal is for.", { synonyms: ["memo"] }),
    a("period", "string", "Period", "Accounting period name.", { synonyms: ["period name", "posting period"] }),
    date("accountingDate", "Accounting date", "Date the journal posts on.", ["effective date", "posting date"]),
    currency,
    a("status", "string", "Status", "Posting status code."),
    a("source", "string", "Source", "Where the journal came from."),
    a("category", "string", "Category", "Journal category."),
    updatedAt,
  ]),
];
