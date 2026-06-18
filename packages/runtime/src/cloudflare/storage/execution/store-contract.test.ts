import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";

describeExecutionStoreContract({
  createStore: () =>
    new DurableObjectExecutionStore({
      prefix: "contract-test",
      storage: new InMemoryCloudflareDurableObjectStorage(),
    }),
  name: "DurableObjectExecutionStore",
});
