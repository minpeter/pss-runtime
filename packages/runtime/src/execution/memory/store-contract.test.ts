import { describeExecutionStoreContract } from "../../contracts/execution-store/contract";
import { createInMemoryExecutionHost } from "./memory-host";

describeExecutionStoreContract({
  createStore: () => createInMemoryExecutionHost().store,
  name: "InMemoryExecutionStore",
});
