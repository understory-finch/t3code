import { createProviderMcpEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-mcp";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerMcpEnvironment = createProviderMcpEnvironmentAtoms(connectionAtomRuntime);
