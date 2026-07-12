// TODO: real implementation lands in a later phase (see ROUTES.md).
export function resourceStub(contentType: string) {
  return function loader() {
    return new Response("TODO", {
      headers: { "content-type": contentType },
    });
  };
}
