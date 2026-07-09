import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import { createInMemoryHost } from "./execution-host";

describeExecutionStoreContract({
  createStore: () => createInMemoryHost().store,
  name: "InMemoryExecutionStore",
});
