import type { ObjectSpec } from "../catalog.js";

// Oracle E-Business Suite R12: base tables and views, as read by the database
// adapter or an EBS REST/SOA service. Y/N flags and dates follow the system's
// dialect, so only codes that are not plain flags need transforms.

const STATUS_AI = { read: '$value = "A"', write: '$value ? "A" : "I"' };

export const ORACLE_EBS: ObjectSpec[] = [
  {
    object: "HZ_CUST_ACCOUNTS",
    entity: "Customer",
    label: "Customer accounts (TCA)",
    fields: {
      ACCOUNT_NUMBER: "number",
      ACCOUNT_NAME: "name",
      STATUS: { attribute: "active", ...STATUS_AI },
      CUSTOMER_CLASS_CODE: "customerClass",
      CREATION_DATE: "createdAt",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "AP_SUPPLIERS",
    entity: "Supplier",
    label: "Suppliers",
    fields: {
      SEGMENT1: "number",
      VENDOR_NAME: "name",
      VENDOR_NAME_ALT: "alternateName",
      ENABLED_FLAG: "active",
      VENDOR_TYPE_LOOKUP_CODE: "supplierType",
      INVOICE_CURRENCY_CODE: "currency",
      NUM_1099: "taxRegistrationNumber",
      CREATION_DATE: "createdAt",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "MTL_SYSTEM_ITEMS_B",
    entity: "Item",
    label: "Inventory items",
    fields: {
      SEGMENT1: "number",
      DESCRIPTION: "description",
      PRIMARY_UOM_CODE: "uom",
      ITEM_TYPE: "itemType",
      INVENTORY_ITEM_STATUS_CODE: "status",
      ENABLED_FLAG: "active",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "OE_ORDER_HEADERS_ALL",
    entity: "SalesOrder",
    label: "Sales order headers",
    fields: {
      ORDER_NUMBER: "number",
      ORDERED_DATE: "orderDate",
      TRANSACTIONAL_CURR_CODE: "currency",
      FLOW_STATUS_CODE: "status",
      CUST_PO_NUMBER: "customerPoNumber",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "PO_HEADERS_ALL",
    entity: "PurchaseOrder",
    label: "Purchase order headers",
    fields: {
      SEGMENT1: "number",
      CREATION_DATE: { attribute: "orderDate", readOnly: true },
      CURRENCY_CODE: "currency",
      AUTHORIZATION_STATUS: "status",
      TYPE_LOOKUP_CODE: "orderType",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "RA_CUSTOMER_TRX_ALL",
    entity: "Invoice",
    label: "Receivables transactions",
    fields: {
      TRX_NUMBER: "number",
      TRX_DATE: "invoiceDate",
      TERM_DUE_DATE: "dueDate",
      INVOICE_CURRENCY_CODE: "currency",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "AP_INVOICES_ALL",
    entity: "SupplierInvoice",
    label: "Payables invoices",
    fields: {
      INVOICE_NUM: "number",
      INVOICE_DATE: "invoiceDate",
      INVOICE_AMOUNT: "totalAmount",
      INVOICE_CURRENCY_CODE: "currency",
      INVOICE_TYPE_LOOKUP_CODE: "invoiceType",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "AR_CASH_RECEIPTS_ALL",
    entity: "Payment",
    label: "Cash receipts",
    fields: {
      RECEIPT_NUMBER: "number",
      RECEIPT_DATE: "receiptDate",
      AMOUNT: "amount",
      CURRENCY_CODE: "currency",
      STATUS: "status",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
  {
    object: "GL_JE_HEADERS",
    entity: "JournalEntry",
    label: "Journal headers",
    fields: {
      DOC_SEQUENCE_VALUE: "number",
      NAME: "name",
      DESCRIPTION: "description",
      PERIOD_NAME: "period",
      DEFAULT_EFFECTIVE_DATE: "accountingDate",
      CURRENCY_CODE: "currency",
      STATUS: "status",
      JE_SOURCE: "source",
      JE_CATEGORY: "category",
      LAST_UPDATE_DATE: "updatedAt",
    },
  },
];
