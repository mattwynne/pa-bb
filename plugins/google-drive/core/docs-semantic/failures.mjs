// Safe semantic failure policy, independent of native result/log envelopes.
const categories=new Set(['invalid','budget','scalar','extent','scope','snapshot','conflict','unavailable','denied','corrupt','unsupported','cancelled']);
export function semanticFailureCategory(error,{cancellation=true}={}) {
  return categories.has(error?.semanticCode)&&(cancellation||error.semanticCode!=='cancelled')?error.semanticCode:'unavailable';
}
export function describeSemanticFailure(error) {
  return {outcome:'unavailable',category:semanticFailureCategory(error),guidance:'Check explicit scope and connected account; expired snapshots require a new inspection.',thisCall:{providerMutationCount:0}};
}
