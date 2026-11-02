// Core interpretation of metadata/observation facts, shared by summary and
// paged inspection. Connectivity/schema support never implies account rollout.
export function inspectionCapabilities(metadata){return{read:{schema:'supported',account:'observed'},nativeSuggestions:{schema:'supported',account:'unverified'},authoring:{product:'not_exposed',account:'unverified'},documentPermission:metadata.capabilities?.canEdit===true?'editorObserved':metadata.capabilities?.canEdit===false?'notEditorObserved':'unverified'};}
export function inspectionProvenance(binding){return{provider:'googleDocs',retrievedAt:binding.retrievedAt,responseDigest:binding.responseDigest,source:'current',effectiveDefaults:'unknownWhenAbsent'};}
