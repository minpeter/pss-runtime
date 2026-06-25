import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import { createInMemoryExecutionHost } from "./execution-host";

describeExecutionStoreContract({
  createStore: () => createInMemoryExecutionHost().store,
  name: "InMemoryExecutionStore",
});
