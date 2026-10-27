import { type ObjectBinding, objectFromSpec, type SystemInfo } from "../catalog.js";
import { NETSUITE } from "./netsuite.js";
import { ORACLE_EBS } from "./oracle-ebs.js";
import { ORACLE_FUSION } from "./oracle-fusion.js";
import { SAP_S4HANA } from "./sap-s4hana.js";

export const PLATFORM_SYSTEMS: SystemInfo[] = [
  {
    id: "oracle-fusion",
    label: "Oracle Fusion Cloud",
    description: "Oracle Fusion Cloud ERP, SCM and CX through their REST resources.",
    objectKind: "REST resource",
    dialect: { booleans: "native", dates: "iso" },
    origin: "platform",
  },
  {
    id: "oracle-ebs",
    label: "Oracle E-Business Suite",
    description: "Oracle EBS R12 tables and views (database adapter, or EBS integrated SOA/REST services).",
    objectKind: "table",
    dialect: { booleans: "YN", dates: "iso" },
    origin: "platform",
  },
  {
    id: "netsuite",
    label: "NetSuite",
    description: "Oracle NetSuite through the REST record service.",
    objectKind: "record type",
    dialect: { booleans: "native", dates: "iso" },
    origin: "platform",
  },
  {
    id: "sap-s4hana",
    label: "SAP S/4HANA",
    description: "SAP S/4HANA (cloud or on-premise) OData V2 APIs.",
    objectKind: "OData entity set",
    dialect: { booleans: "native", dates: "odata-v2" },
    origin: "platform",
  },
];

export const PLATFORM_OBJECTS: ObjectBinding[] = [
  ...ORACLE_FUSION.map((s) => objectFromSpec("oracle-fusion", s)),
  ...ORACLE_EBS.map((s) => objectFromSpec("oracle-ebs", s)),
  ...NETSUITE.map((s) => objectFromSpec("netsuite", s)),
  ...SAP_S4HANA.map((s) => objectFromSpec("sap-s4hana", s)),
];
