import type { ObjectSpec } from "../catalog.js";

// NetSuite REST record service (record/v1). References are { id, refName }
// objects; their names are read through dotted paths and never written.

const INVERTED = { read: "$not($value)", write: "$not($value)" };

export const NETSUITE: ObjectSpec[] = [
  {
    object: "customer",
    entity: "Customer",
    label: "Customer",
    fields: {
      entityId: "number",
      companyName: "name",
      isInactive: { attribute: "active", ...INVERTED },
      email: "email",
      phone: "phone",
      dateCreated: { attribute: "createdAt", readOnly: true },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "vendor",
    entity: "Supplier",
    label: "Vendor",
    fields: {
      entityId: "number",
      companyName: "name",
      isInactive: { attribute: "active", ...INVERTED },
      email: "email",
      phone: "phone",
      dateCreated: { attribute: "createdAt", readOnly: true },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "inventoryItem",
    entity: "Item",
    label: "Inventory item",
    fields: {
      itemId: "number",
      displayName: "description",
      isInactive: { attribute: "active", ...INVERTED },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "salesOrder",
    entity: "SalesOrder",
    label: "Sales order",
    fields: {
      tranId: "number",
      tranDate: "orderDate",
      otherRefNum: "customerPoNumber",
      "status.refName": { attribute: "status", readOnly: true },
      total: { attribute: "totalAmount", readOnly: true },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "purchaseOrder",
    entity: "PurchaseOrder",
    label: "Purchase order",
    fields: {
      tranId: "number",
      tranDate: "orderDate",
      "status.refName": { attribute: "status", readOnly: true },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "invoice",
    entity: "Invoice",
    label: "Invoice",
    fields: {
      tranId: "number",
      tranDate: "invoiceDate",
      dueDate: "dueDate",
      total: { attribute: "totalAmount", readOnly: true },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "vendorBill",
    entity: "SupplierInvoice",
    label: "Vendor bill",
    fields: {
      tranId: "number",
      transactionNumber: { attribute: "documentNumber", readOnly: true },
      tranDate: "invoiceDate",
      dueDate: "dueDate",
      userTotal: "totalAmount",
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "customerPayment",
    entity: "Payment",
    label: "Customer payment",
    fields: {
      tranId: "number",
      tranDate: "receiptDate",
      payment: "amount",
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "journalEntry",
    entity: "JournalEntry",
    label: "Journal entry",
    fields: {
      tranId: "number",
      tranDate: "accountingDate",
      memo: "description",
      "postingPeriod.refName": { attribute: "period", readOnly: true },
      lastModifiedDate: { attribute: "updatedAt", readOnly: true },
    },
  },
];
