import type {
  CloudflareDurableObjectNamespace,
  CloudflareDurableObjectStub,
} from "./cloudflare-host";

export interface CloudflareDurableObjectStubOptions<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> {
  readonly namespace?: CloudflareDurableObjectNamespace<Stub>;
  readonly objectName: string;
}

export interface CloudflareDurableObjectFetchOptions<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> extends CloudflareDurableObjectStubOptions<Stub> {
  readonly request: Request;
}

export function getCloudflareDurableObjectStub<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
>({
  namespace,
  objectName,
}: CloudflareDurableObjectStubOptions<Stub>): Stub | undefined {
  return namespace?.get(namespace.idFromName(objectName));
}

export async function fetchCloudflareDurableObject<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
>({
  request,
  ...options
}: CloudflareDurableObjectFetchOptions<Stub>): Promise<Response | undefined> {
  return await getCloudflareDurableObjectStub(options)?.fetch(request);
}
