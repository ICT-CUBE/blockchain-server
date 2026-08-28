import { readFileSync } from 'node:fs';
import path from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { load as loadYaml } from 'js-yaml';

/** `docs/openapi.yaml` lives outside the repository (non-versioned design docs) — one level above
 * `blockchain-server/`. The contract test is skipped with a clear message when it is not present. */
export const OPENAPI_PATH = path.join(__dirname, '..', '..', '..', '..', 'docs', 'openapi.yaml');

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  webhooks?: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, unknown> };
}

interface OpenApiOperation {
  operationId?: string;
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  requestBody?: { content?: Record<string, { schema?: unknown }> };
}

function rewriteLocalRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteLocalRefs);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `openapi${v}` : rewriteLocalRefs(v);
    }
    return out;
  }
  return value;
}

/**
 * Loads the OpenAPI document once and compiles every referenced schema with Ajv (draft 2020-12,
 * which OpenAPI 3.1 uses). `$ref`s of the form `#/components/schemas/X` resolve because the whole
 * document is registered under a single root id.
 */
export class OpenApiValidator {
  private readonly ajv: Ajv2020;
  private readonly doc: OpenApiDocument;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(documentPath = OPENAPI_PATH) {
    this.doc = loadYaml(readFileSync(documentPath, 'utf8')) as OpenApiDocument;
    this.ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
    addFormats(this.ajv);
    // Register the document (with its own internal refs made absolute) so
    // `openapi#/components/schemas/...` resolves from any inline schema.
    this.ajv.addSchema({ $id: 'openapi', components: rewriteLocalRefs(this.doc.components) }, 'openapi');
  }

  /** Validates `body` against `paths[path][method].responses[status]` JSON schema. Throws a
   * descriptive error listing every schema violation. */
  assertResponse(method: string, pathTemplate: string, status: number, body: unknown): void {
    const operation = this.operation(method, pathTemplate);
    const response = this.deref(operation.responses[String(status)] ?? operation.responses.default);
    if (!response) {
      throw new Error(
        `OpenAPI: no response ${status} (or default) documented for ${method.toUpperCase()} ${pathTemplate}`,
      );
    }
    const schema = response.content?.['application/json']?.schema;
    if (!schema) {
      throw new Error(
        `OpenAPI: response ${status} for ${method.toUpperCase()} ${pathTemplate} has no JSON schema`,
      );
    }
    this.assertAgainst(schema, body, `${method.toUpperCase()} ${pathTemplate} -> ${status}`);
  }

  assertRequestBody(method: string, pathTemplate: string, body: unknown): void {
    const schema = this.operation(method, pathTemplate).requestBody?.content?.['application/json']?.schema;
    if (!schema) {
      throw new Error(`OpenAPI: no request body schema for ${method.toUpperCase()} ${pathTemplate}`);
    }
    this.assertAgainst(schema, body, `${method.toUpperCase()} ${pathTemplate} request`);
  }

  assertWebhook(name: string, body: unknown): void {
    const hook = this.doc.webhooks?.[name]?.post;
    const schema = hook?.requestBody?.content?.['application/json']?.schema;
    if (!schema) {
      throw new Error(`OpenAPI: webhook ${name} has no request schema`);
    }
    this.assertAgainst(schema, body, `webhook ${name}`);
  }

  documentedPaths(): string[] {
    return Object.keys(this.doc.paths);
  }

  /** Resolves a document-level `$ref` (e.g. `#/components/responses/Unauthorized`) to the object it
   * points at; returns non-ref values unchanged. */
  private deref<T>(value: T): T {
    if (typeof value === 'object' && value !== null && '$ref' in (value as Record<string, unknown>)) {
      const ref = (value as unknown as { $ref: string }).$ref;
      if (ref.startsWith('#/')) {
        let cursor: unknown = this.doc;
        for (const segment of ref.slice(2).split('/')) {
          cursor = (cursor as Record<string, unknown> | undefined)?.[
            segment.replace(/~1/g, '/').replace(/~0/g, '~')
          ];
        }
        return cursor as T;
      }
    }
    return value;
  }

  private operation(method: string, pathTemplate: string): OpenApiOperation {
    const item = this.doc.paths[pathTemplate];
    const operation = item?.[method.toLowerCase()];
    if (!operation) {
      throw new Error(`OpenAPI: ${method.toUpperCase()} ${pathTemplate} is not documented`);
    }
    return operation;
  }

  private assertAgainst(schema: unknown, body: unknown, label: string): void {
    const key = JSON.stringify(schema);
    let validate = this.cache.get(key);
    if (!validate) {
      // Point every document-relative `#/components/...` ref at the registered document root so an
      // inline (anonymous) schema can be compiled on its own.
      validate = this.ajv.compile(rewriteLocalRefs(schema) as object);
      this.cache.set(key, validate);
    }
    if (!validate(body)) {
      const errors = (validate.errors ?? [])
        .map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`)
        .join('\n  ');
      throw new Error(
        `OpenAPI contract violation for ${label}:\n  ${errors}\nbody: ${JSON.stringify(body).slice(0, 800)}`,
      );
    }
  }
}
