/**
 * OpenAPI 3.1 description of the /v1 API. Served at /v1/openapi.json. A unit test checks that every route file
 * under src/app/v1 has a matching path here, so the document cannot silently fall behind the code.
 */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } })
const err = { $ref: "#/components/responses/Error" }
const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } })
const body = (schema: object) => ({ required: true, content: { "application/json": { schema } } })
const errors = { 400: err, 401: err, 404: err }

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "DumpBox API",
    version: "1.0.0",
    description:
      "One API for every DumpBox client. Authenticate with `Authorization: Bearer <Supabase access token>`. " +
      "Errors use `{ error: { code, message, details? } }`. Lists use cursors; sync uses `/v1/changes`.",
  },
  servers: [{ url: "/" }],
  security: [{ bearer: [] }],
  tags: [
    { name: "Items" },
    { name: "Files" },
    { name: "Organize" },
    { name: "Search and sync" },
    { name: "Sharing" },
    { name: "Account" },
  ],
  paths: {
    "/v1/items": {
      get: {
        tags: ["Items"],
        summary: "Feed (newest first)",
        parameters: [
          { name: "view", in: "query", schema: { type: "string", enum: ["feed", "pinned", "starred", "archived", "trash"], default: "feed" } },
          { name: "type", in: "query", description: "Comma-separated item types", schema: { type: "string" } },
          { name: "tag", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "collection", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 40 } },
        ],
        responses: {
          200: json({ type: "object", properties: { items: { type: "array", items: ref("Item") }, next_cursor: { type: ["string", "null"] } } }),
          ...errors,
        },
      },
      post: {
        tags: ["Items"],
        summary: "Capture an item (idempotent when `id` is sent)",
        requestBody: body(ref("CreateItem")),
        responses: {
          200: json({ type: "object", properties: { item: ref("Item"), created: { const: false } } }, "Already existed"),
          201: json({ type: "object", properties: { item: ref("Item"), created: { const: true } } }, "Created"),
          ...errors,
        },
      },
    },
    "/v1/items/{id}": {
      parameters: [idParam()],
      get: { tags: ["Items"], summary: "One item", responses: { 200: json({ type: "object", properties: { item: ref("Item") } }), ...errors } },
      patch: {
        tags: ["Items"],
        summary: "Edit fields (send only what changed)",
        requestBody: body(ref("UpdateItem")),
        responses: {
          200: json({ type: "object", properties: { item: ref("Item"), merged: { type: "boolean" } } }),
          410: err,
          ...errors,
        },
      },
      delete: {
        tags: ["Items"],
        summary: "Move to trash, or remove for good with ?permanent=true",
        parameters: [{ name: "permanent", in: "query", schema: { type: "boolean" } }],
        responses: { 200: json({ type: "object", properties: { item: ref("Item") } }), 204: { description: "Removed" }, ...errors },
      },
    },
    "/v1/items/{id}/restore": {
      parameters: [idParam()],
      post: { tags: ["Items"], summary: "Restore from trash", responses: { 200: json({ type: "object", properties: { item: ref("Item") } }), ...errors } },
    },
    "/v1/items/{id}/versions": {
      parameters: [idParam()],
      get: {
        tags: ["Items"],
        summary: "Previous 10 versions of a note",
        responses: {
          200: json({
            type: "object",
            properties: {
              versions: {
                type: "array",
                items: {
                  type: "object",
                  properties: { version: { type: "integer" }, title: { type: ["string", "null"] }, body: { type: ["string", "null"] }, created_at: { type: "string" } },
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    "/v1/items/{id}/tags": {
      parameters: [idParam()],
      put: {
        tags: ["Organize"],
        summary: "Set the item's tags by name",
        requestBody: body({ type: "object", required: ["tags"], properties: { tags: { type: "array", items: { type: "string", maxLength: 50 }, maxItems: 20 } } }),
        responses: { 200: json({ type: "object", properties: { item: ref("Item") } }), ...errors },
      },
    },
    "/v1/items/{id}/collections": {
      parameters: [idParam()],
      put: {
        tags: ["Organize"],
        summary: "Set the item's collections",
        requestBody: body({
          type: "object",
          required: ["collection_ids"],
          properties: { collection_ids: { type: "array", items: { type: "string", format: "uuid" } } },
        }),
        responses: { 200: json({ type: "object", properties: { item: ref("Item") } }), ...errors },
      },
    },
    "/v1/items/{id}/files": {
      parameters: [idParam()],
      post: {
        tags: ["Files"],
        summary: "Register an uploaded file (step 3)",
        requestBody: body({
          type: "object",
          required: ["file_id", "storage_path", "file_name", "mime_type"],
          properties: {
            file_id: { type: "string", format: "uuid" },
            storage_path: { type: "string" },
            file_name: { type: "string" },
            mime_type: { type: "string" },
            sha256: { type: "string" },
            width: { type: "integer" },
            height: { type: "integer" },
          },
        }),
        responses: { 200: json({ type: "object", properties: { item: ref("Item") } }), 201: json({ type: "object", properties: { item: ref("Item") } }), 415: err, ...errors },
      },
    },
    "/v1/items/bulk": {
      post: {
        tags: ["Organize"],
        summary: "One action on many items",
        requestBody: body({
          type: "object",
          required: ["ids", "action"],
          properties: {
            ids: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 200 },
            action: {
              type: "string",
              enum: ["pin", "unpin", "star", "unstar", "archive", "unarchive", "delete", "restore", "add_tags", "remove_tags", "add_to_collection", "remove_from_collection"],
            },
            tags: { type: "array", items: { type: "string" } },
            collection_id: { type: "string", format: "uuid" },
          },
        }),
        responses: { 200: json({ type: "object", properties: { items: { type: "array", items: ref("Item") }, affected: { type: "integer" } } }), ...errors },
      },
    },
    "/v1/uploads": {
      post: {
        tags: ["Files"],
        summary: "Get a signed upload URL (step 1); then PUT the bytes to it (step 2)",
        requestBody: body({
          type: "object",
          required: ["item_id", "file_name", "mime_type", "size_bytes"],
          properties: {
            item_id: { type: "string", format: "uuid" },
            file_name: { type: "string" },
            mime_type: { type: "string" },
            size_bytes: { type: "integer" },
            sha256: { type: "string", description: "Hex SHA-256, enables duplicate detection" },
          },
        }),
        responses: {
          201: json({
            type: "object",
            properties: {
              file_id: { type: "string" },
              storage_path: { type: "string" },
              upload_url: { type: "string" },
              upload_token: { type: "string" },
              max_bytes: { type: "integer" },
              duplicate_of: { type: ["object", "null"], properties: { item_id: { type: "string" }, file_id: { type: "string" } } },
            },
          }),
          413: err,
          415: err,
          ...errors,
        },
      },
    },
    "/v1/files/{id}": {
      parameters: [idParam()],
      get: {
        tags: ["Files"],
        summary: "Short-lived view and download URLs",
        responses: {
          200: json({ type: "object", properties: { view_url: { type: "string" }, download_url: { type: "string" }, expires_in: { type: "integer" } } }),
          ...errors,
        },
      },
      delete: { tags: ["Files"], summary: "Remove a file", responses: { 204: { description: "Removed" }, ...errors } },
    },
    "/v1/tags": {
      get: { tags: ["Organize"], summary: "List tags", responses: { 200: json({ type: "object", properties: { tags: { type: "array", items: ref("Tag") } } }), ...errors } },
      post: {
        tags: ["Organize"],
        summary: "Create a tag",
        requestBody: body({ type: "object", required: ["name"], properties: { name: { type: "string" }, color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } } }),
        responses: { 201: json({ type: "object", properties: { tag: ref("Tag") } }), 409: err, ...errors },
      },
    },
    "/v1/tags/{id}": {
      parameters: [idParam()],
      patch: {
        tags: ["Organize"],
        summary: "Rename or recolour a tag",
        requestBody: body({ type: "object", properties: { name: { type: "string" }, color: { type: "string" } } }),
        responses: { 200: json({ type: "object", properties: { tag: ref("Tag") } }), 409: err, ...errors },
      },
      delete: { tags: ["Organize"], summary: "Delete a tag (items stay)", responses: { 204: { description: "Deleted" }, ...errors } },
    },
    "/v1/collections": {
      get: {
        tags: ["Organize"],
        summary: "List collections",
        responses: { 200: json({ type: "object", properties: { collections: { type: "array", items: ref("Collection") } } }), ...errors },
      },
      post: {
        tags: ["Organize"],
        summary: "Create a collection",
        requestBody: body({ type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" } } }),
        responses: { 201: json({ type: "object", properties: { collection: ref("Collection") } }), 409: err, ...errors },
      },
    },
    "/v1/collections/{id}": {
      parameters: [idParam()],
      patch: {
        tags: ["Organize"],
        summary: "Rename a collection",
        requestBody: body({ type: "object", properties: { name: { type: "string" }, description: { type: "string" } } }),
        responses: { 200: json({ type: "object", properties: { collection: ref("Collection") } }), 409: err, ...errors },
      },
      delete: { tags: ["Organize"], summary: "Delete a collection (items stay)", responses: { 204: { description: "Deleted" }, ...errors } },
    },
    "/v1/search": {
      get: {
        tags: ["Search and sync"],
        summary: "Keyword search with typo tolerance and filters",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "tags", in: "query", description: "Comma-separated tag ids (all must match)", schema: { type: "string" } },
          { name: "collection", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "starred", in: "query", schema: { type: "boolean" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "include_archived", in: "query", schema: { type: "boolean", default: true } },
          { name: "limit", in: "query", schema: { type: "integer", default: 30 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          200: json({
            type: "object",
            properties: {
              results: {
                type: "array",
                items: { type: "object", properties: { item: ref("Item"), highlight: { type: "string" }, rank: { type: "number" } } },
              },
              next_offset: { type: ["integer", "null"] },
            },
          }),
          ...errors,
        },
      },
    },
    "/v1/changes": {
      get: {
        tags: ["Search and sync"],
        summary: "Everything changed since a sync token",
        parameters: [
          { name: "since", in: "query", schema: { type: "string" } },
          { name: "start", in: "query", description: "`now`: return only a token at the present", schema: { type: "string", enum: ["now"] } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 500, default: 500 } },
        ],
        responses: {
          200: json({
            type: "object",
            properties: {
              items: { type: "array", items: ref("Item") },
              deleted_ids: { type: "array", items: { type: "string" } },
              next_since: { type: ["string", "null"] },
              has_more: { type: "boolean" },
              reset: { type: "boolean", description: "Drop the local cache and sync again without `since`" },
              server_time: { type: "string" },
            },
          }),
          ...errors,
        },
      },
    },
    "/v1/shares": {
      get: { tags: ["Sharing"], summary: "List share links", responses: { 200: json({ type: "object", properties: { shares: { type: "array", items: ref("Share") } } }), ...errors } },
      post: {
        tags: ["Sharing"],
        summary: "Create a private link (the URL is shown once)",
        requestBody: body({
          type: "object",
          properties: {
            item_id: { type: "string", format: "uuid" },
            collection_id: { type: "string", format: "uuid" },
            expires_in_days: { type: "integer", minimum: 1, maximum: 365 },
            allow_download: { type: "boolean", default: true },
          },
        }),
        responses: { 201: json({ type: "object", properties: { share: ref("Share"), url: { type: "string" } } }), 410: err, ...errors },
      },
    },
    "/v1/shares/{id}": {
      parameters: [idParam()],
      delete: { tags: ["Sharing"], summary: "Revoke a link", responses: { 200: json({ type: "object", properties: { share: ref("Share") } }), ...errors } },
    },
    "/v1/public/shares/{token}": {
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      get: {
        tags: ["Sharing"],
        summary: "Open a shared link (no sign-in)",
        security: [],
        responses: {
          200: json({
            type: "object",
            properties: {
              kind: { type: "string", enum: ["item", "collection"] },
              collection_name: { type: ["string", "null"] },
              allow_download: { type: "boolean" },
              items: { type: "array", items: { type: "object" } },
            },
          }),
          404: err,
        },
      },
    },
    "/v1/me": {
      get: { tags: ["Account"], summary: "Profile and usage", responses: { 200: json({ type: "object" }), 401: err } },
      patch: {
        tags: ["Account"],
        summary: "Update name and time zone",
        requestBody: body({ type: "object", properties: { name: { type: "string" }, time_zone: { type: "string" } } }),
        responses: { 200: json({ type: "object" }), ...errors },
      },
      delete: {
        tags: ["Account"],
        summary: "Delete the account and all data",
        requestBody: body({ type: "object", required: ["confirm"], properties: { confirm: { const: "DELETE" } } }),
        responses: { 204: { description: "Deleted" }, ...errors },
      },
    },
    "/v1/export": {
      get: { tags: ["Account"], summary: "Export everything as JSON", responses: { 200: json({ type: "object" }), 401: err } },
    },
    "/v1/health": {
      get: { tags: ["Account"], summary: "Liveness", security: [], responses: { 200: json({ type: "object" }) } },
    },
    "/v1/internal/purge": {
      get: {
        tags: ["Account"],
        summary: "Daily trash purge (cron only, Bearer CRON_SECRET)",
        responses: { 200: json({ type: "object" }), 401: err },
      },
    },
    "/v1/openapi.json": {
      get: { tags: ["Account"], summary: "This document", security: [], responses: { 200: json({ type: "object" }) } },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Supabase access token" } },
    responses: {
      Error: {
        description: "Error",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] },
              },
            },
          },
        },
      },
    },
    schemas: {
      Item: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          type: { type: "string", enum: ["note", "link", "file", "image", "location", "voice"] },
          title: { type: ["string", "null"] },
          body: { type: ["string", "null"] },
          source: { type: "string" },
          url: { type: ["string", "null"] },
          link: {
            type: ["object", "null"],
            properties: { title: { type: ["string", "null"] }, description: { type: ["string", "null"] }, image_url: { type: ["string", "null"] }, site: { type: ["string", "null"] } },
          },
          location: {
            type: ["object", "null"],
            properties: { latitude: { type: "number" }, longitude: { type: "number" }, label: { type: ["string", "null"] } },
          },
          pinned: { type: "boolean" },
          starred: { type: "boolean" },
          archived_at: { type: ["string", "null"] },
          deleted_at: { type: ["string", "null"] },
          version: { type: "integer" },
          created_at: { type: "string" },
          updated_at: { type: "string" },
          tags: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, color: { type: ["string", "null"] } } } },
          collection_ids: { type: "array", items: { type: "string" } },
          files: { type: "array", items: ref("File") },
        },
      },
      File: {
        type: "object",
        properties: {
          id: { type: "string" },
          file_name: { type: "string" },
          mime_type: { type: "string" },
          size_bytes: { type: "integer" },
          sha256: { type: ["string", "null"] },
          width: { type: ["integer", "null"] },
          height: { type: ["integer", "null"] },
          created_at: { type: "string" },
        },
      },
      CreateItem: {
        type: "object",
        required: ["type"],
        properties: {
          id: { type: "string", format: "uuid", description: "Client-generated; makes retries safe" },
          type: { type: "string", enum: ["note", "link", "file", "image", "location", "voice"] },
          title: { type: "string" },
          body: { type: "string" },
          url: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          location_label: { type: "string" },
          source: { type: "string", enum: ["web", "android", "ios", "desktop", "extension", "api"] },
          captured_at: { type: "string", format: "date-time" },
          pinned: { type: "boolean" },
          starred: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          collection_ids: { type: "array", items: { type: "string", format: "uuid" } },
        },
      },
      UpdateItem: {
        type: "object",
        properties: {
          title: { type: ["string", "null"] },
          body: { type: ["string", "null"] },
          location_label: { type: ["string", "null"] },
          pinned: { type: "boolean" },
          starred: { type: "boolean" },
          archived: { type: "boolean" },
          base_version: { type: "integer" },
        },
      },
      Tag: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, color: { type: ["string", "null"] }, item_count: { type: "integer" } },
      },
      Collection: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          item_count: { type: "integer" },
          created_at: { type: "string" },
          updated_at: { type: "string" },
        },
      },
      Share: {
        type: "object",
        properties: {
          id: { type: "string" },
          item_id: { type: ["string", "null"] },
          collection_id: { type: ["string", "null"] },
          allow_download: { type: "boolean" },
          expires_at: { type: ["string", "null"] },
          open_count: { type: "integer" },
          last_opened_at: { type: ["string", "null"] },
          revoked_at: { type: ["string", "null"] },
          created_at: { type: "string" },
          active: { type: "boolean" },
        },
      },
    },
  },
} as const
