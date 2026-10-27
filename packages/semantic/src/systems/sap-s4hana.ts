import type { ObjectSpec } from "../catalog.js";

// SAP S/4HANA OData V2 APIs (API_BUSINESS_PARTNER, API_PRODUCT_SRV,
// API_SALES_ORDER_SRV, API_PURCHASEORDER_PROCESS_SRV, API_BILLING_DOCUMENT_SRV,
// API_SUPPLIERINVOICE_PROCESS_SRV). Dates use the /Date(ms)/ dialect.

const NOT = { read: "$not($value)", write: "$not($value)" };

export const SAP_S4HANA: ObjectSpec[] = [
  {
    object: "A_Customer",
    entity: "Customer",
    label: "Customer (API_BUSINESS_PARTNER)",
    fields: {
      Customer: "number",
      CustomerName: "name",
      DeletionIndicator: { attribute: "active", ...NOT },
      CustomerAccountGroup: "customerClass",
      CreationDate: { attribute: "createdAt", readOnly: true },
    },
  },
  {
    object: "A_Supplier",
    entity: "Supplier",
    label: "Supplier (API_BUSINESS_PARTNER)",
    fields: {
      Supplier: "number",
      SupplierName: "name",
      DeletionIndicator: { attribute: "active", ...NOT },
      SupplierAccountGroup: "supplierType",
      TaxNumber1: "taxRegistrationNumber",
      CreationDate: { attribute: "createdAt", readOnly: true },
    },
  },
  {
    object: "A_Product",
    entity: "Item",
    label: "Product (API_PRODUCT_SRV)",
    fields: {
      Product: "number",
      ProductType: "itemType",
      BaseUnit: "uom",
      IsMarkedForDeletion: { attribute: "active", ...NOT },
      LastChangeDateTime: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "A_SalesOrder",
    entity: "SalesOrder",
    label: "Sales order (API_SALES_ORDER_SRV)",
    fields: {
      SalesOrder: "number",
      SoldToParty: "customer",
      SalesOrderDate: "orderDate",
      TransactionCurrency: "currency",
      OverallSDProcessStatus: { attribute: "status", readOnly: true },
      PurchaseOrderByCustomer: "customerPoNumber",
      TotalNetAmount: { attribute: "totalAmount", readOnly: true },
      LastChangeDateTime: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "A_PurchaseOrder",
    entity: "PurchaseOrder",
    label: "Purchase order (API_PURCHASEORDER_PROCESS_SRV)",
    fields: {
      PurchaseOrder: "number",
      Supplier: "supplier",
      PurchaseOrderDate: "orderDate",
      DocumentCurrency: "currency",
      PurchaseOrderType: "orderType",
      PurchasingProcessingStatus: { attribute: "status", readOnly: true },
      CompanyCode: "businessUnit",
      LastChangeDateTime: { attribute: "updatedAt", readOnly: true },
    },
  },
  {
    object: "A_BillingDocument",
    entity: "Invoice",
    label: "Billing document (API_BILLING_DOCUMENT_SRV)",
    fields: {
      BillingDocument: "number",
      SoldToParty: "customer",
      BillingDocumentDate: "invoiceDate",
      TransactionCurrency: "currency",
      TotalNetAmount: "totalAmount",
      BillingDocumentType: "transactionType",
      CompanyCode: "businessUnit",
    },
  },
  {
    object: "A_SupplierInvoice",
    entity: "SupplierInvoice",
    label: "Supplier invoice (API_SUPPLIERINVOICE_PROCESS_SRV)",
    fields: {
      SupplierInvoiceIDByInvcgParty: "number",
      SupplierInvoice: { attribute: "documentNumber", readOnly: true },
      InvoicingParty: "supplier",
      DocumentDate: "invoiceDate",
      InvoiceGrossAmount: "totalAmount",
      DocumentCurrency: "currency",
      FiscalYear: { attribute: "fiscalYear", readOnly: true },
      CompanyCode: "businessUnit",
    },
  },
];
