/** Drop custom-field rows left completely empty and trim names before saving. */
export function cleanFields(fields = []) {
  return fields
    .map((f) => ({ ...f, name: f.name.trim(), value: f.value }))
    .filter((f) => f.name || f.value.trim());
}
