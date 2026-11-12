// Module hooks that map the host packages this plugin imports onto the local
// stubs, so the contract test can run the source without a host installation.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./tools.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-sandbox') {
    return { url: new URL('./sandbox.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: new URL('./llm.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
