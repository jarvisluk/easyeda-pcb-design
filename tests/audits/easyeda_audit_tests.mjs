#!/usr/bin/env node

import { runBaselineAuditTests } from "./baseline_audit_tests.mjs";
import { runCollectorAuditTests } from "./collector_audit_tests.mjs";
import { runCoreAuditTests } from "./core_audit_tests.mjs";
import { runSpecialistAuditTests } from "./specialist_audit_tests.mjs";

runCoreAuditTests();
runBaselineAuditTests();
runSpecialistAuditTests();
await runCollectorAuditTests();

process.stdout.write("easyeda audit tests passed\n");
