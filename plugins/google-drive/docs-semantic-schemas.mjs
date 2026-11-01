import { z } from 'zod';
const id=z.string().min(1).max(256),account=z.string().min(1).max(320);
export const semanticScopeSchema=z.object({tabs:z.union([
  z.object({all:z.literal(true)}).strict(),z.object({ids:z.array(id).min(1).max(100)}).strict(),
  z.object({path:z.array(z.string().min(1).max(256)).min(1).max(32)}).strict(),
  z.object({ordinal:z.number().int().min(0).max(99999),snapshotId:id}).strict()]),
  segments:z.array(z.union([z.object({kind:z.literal('body')}).strict(),z.object({kind:z.enum(['header','footer','footnote']),id:id.optional()}).strict()])).min(1).max(100)}).strict();
const cardinality=z.union([z.object({exactly:z.number().int().min(1).max(500)}).strict(),z.object({occurrence:z.number().int().min(0).max(499)}).strict(),z.object({all:z.number().int().min(1).max(500)}).strict()]);
const text={literal:z.string().min(1).max(2000),normalization:z.enum(['exact','typographic','nfc']).optional(),casePolicy:z.enum(['exact','simpleCaseFold']).optional()};
const heading={headingId:id.optional(),text:z.string().min(1).max(2000).optional(),path:z.array(z.string().min(1).max(2000)).min(1).max(32).optional(),level:z.number().int().min(1).max(6).optional(),depth:z.number().int().min(0).max(32).optional()};
const oneHeading=h=>['headingId','path','text'].filter(key=>h[key]!==undefined).length===1;
const headingSchema=z.object(heading).strict().refine(oneHeading,'Choose headingId, exact text or path');
const sectionSchema=z.object({...heading,includeHeading:z.boolean(),before:headingSchema.optional()}).strict().refine(oneHeading,'Choose headingId, exact text or path');
export const semanticSelectorSchema=z.union([
  z.object({node:id}).strict(),z.object({span:z.object({from:id,to:id}).strict()}).strict(),
  z.object({heading:headingSchema}).strict(),z.object({section:sectionSchema}).strict(),
  z.object({text:z.object({...text,cardinality:cardinality.optional()}).strict()}).strict(),
]);
const snapshot={account,snapshotId:id};
const registryKinds=z.array(z.enum(['styles','lists','objects','ranges','review','diagnostics'])).min(1).max(6);
const readSelector=z.union([
  z.object({node:id}).strict(),z.object({span:z.object({from:id,to:id}).strict()}).strict(),
  z.object({heading:headingSchema}).strict(),z.object({section:sectionSchema}).strict(),
]);
export const SEMANTIC_READ_SCHEMAS=Object.freeze({
  docs_inspect:z.union([z.object({account,document:z.string().min(1).max(1024),scope:semanticScopeSchema,view:z.enum(['inline','acceptedPreview','rejectedPreview']).optional(),outlineDepth:z.number().int().min(0).max(32).optional(),include:z.array(z.enum(['tabs','outline','styles','lists','objects','ranges','review','diagnostics'])).min(1).max(8).optional()}).strict(),
    z.object({...snapshot,cursor:z.string().min(1).max(128)}).strict()]),
  docs_read:z.union([z.object({...snapshot,scope:semanticScopeSchema,selector:readSelector.optional(),format:z.enum(['text','structured']),styles:z.boolean().optional(),review:z.boolean().optional(),omitImages:z.boolean().optional(),registries:registryKinds.optional()}).strict(),
    z.object({...snapshot,cursor:z.string().min(1).max(128)}).strict()]),
  docs_find:z.union([z.object({...snapshot,scope:semanticScopeSchema,query:z.object({...text,limit:z.number().int().min(1).max(500).optional()}).strict()}).strict(),
    z.object({...snapshot,scope:semanticScopeSchema,selector:semanticSelectorSchema}).strict()]),
});
export const SEMANTIC_READ_TOOL_NAMES=Object.freeze(Object.keys(SEMANTIC_READ_SCHEMAS));
