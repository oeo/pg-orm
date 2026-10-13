import type { AggregateOptions, LockMode, SortDirection } from "./types";

const LOCK_CLAUSES: Record<LockMode, string> = {
  update: "FOR UPDATE",
  nowait: "FOR UPDATE NOWAIT",
  skipLocked: "FOR UPDATE SKIP LOCKED",
};

/**
 * A filter or update the converter does not understand. It fails closed: a
 * dropped operator would widen an update or delete to every row. Carries
 * status 400 so an HTTP layer can answer a bad client filter as a bad request.
 */
export class QueryError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export function lockClause(lock: LockMode): string {
  const clause = LOCK_CLAUSES[lock];
  if (!clause) throw new Error(`unknown lock mode: ${lock}`);
  return clause;
}

export class MongoToPG {
  // Internal state for parameters during a single conversion
  #params: any[] = [];
  // fields `$text` searches (SchemaOptions.textFields)
  #textFields?: string[];
  // placeholder of the last `$text` search, reused by a `$textScore` sort
  #textQuery?: string;

  constructor(options: { textFields?: string[] } = {}) {
    this.#textFields = options.textFields;
  }

  // Helper to add a parameter and return its placeholder
  #addParam(value: any): string {
    this.#params.push(value);
    return `$${this.#params.length}`;
  }

  /**
   * Converts MongoDB query object to parameterized SQL query parts for SELECT.
   * `columns` replaces the selected column list (default: the json column);
   * `lock` appends a row-locking clause after LIMIT/OFFSET.
   * @returns Object containing { sql: string, params: any[] }
   */
  buildSelectQueryAndParams(
    collection: string,
    query: Record<string, any>,
    options: {
      jsonField?: string;
      schema?: string;
      limit?: number;
      offset?: number; // Added offset support
      sort?: Record<string, SortDirection>; // Use SortDirection type
      columns?: string;
      lock?: LockMode;
      select?: string[];
    } = {},
  ): { sql: string; params: any[] } {
    this.#params = []; // Reset parameters for this conversion
    this.#textQuery = undefined;
    const {
      jsonField = "data",
      schema: schemaOption,
      limit,
      offset, // Use offset
      sort,
    } = options;

    const tableRef = options.schema
      ? `${this.#quoteIdent(options.schema)}.${this.#quoteIdent(collection)}`
      : this.#quoteIdent(collection);
    const whereClause = this.#buildWhereClause(query, jsonField);

    const columns = options.select
      ? this.#projection(options.select, jsonField)
      : (options.columns ?? this.#quoteIdent(jsonField));
    let sqlQuery = `SELECT ${columns} FROM ${tableRef}`;

    // Fix 1: Be absolutely explicit about checking for 'TRUE' string
    if (whereClause === "TRUE") {
      sqlQuery += ` WHERE TRUE`;
    } else if (whereClause) {
      // Check if not empty string
      sqlQuery += ` WHERE ${whereClause}`;
    }

    for (const [option, value] of Object.entries({ limit, offset })) {
      if (value != null && (!Number.isSafeInteger(value) || value < 0))
        throw new QueryError(`${option} must be a non-negative integer`);
    }
    if (sort && Object.keys(sort).length > 0)
      sqlQuery += this.#buildSortClause(sort, jsonField);
    if (limit) sqlQuery += ` LIMIT ${limit}`;
    if (offset) sqlQuery += ` OFFSET ${offset}`;
    if (options.lock) sqlQuery += ` ${lockClause(options.lock)}`;

    return { sql: sqlQuery.trim(), params: this.#params };
  }

  /**
   * Builds only the WHERE clause and parameters from a MongoDB query object.
   * Placeholders continue after `params`, which are returned first, so
   * several filters can share one statement without renumbering.
   * @returns Object containing { whereClause: string (e.g., "WHERE ..."), params: any[] }
   */
  buildWhereClauseAndParams(
    query: Record<string, any>,
    jsonField: string = "data",
    params: any[] = [],
  ): { whereClause: string; params: any[] } {
    this.#params = [...params];
    this.#textQuery = undefined;
    const whereClause = this.#buildWhereClause(query, jsonField);
    // Return clause with "WHERE" prefix if not empty
    return {
      whereClause: whereClause ? `WHERE ${whereClause}` : "",
      params: this.#params,
    };
  }

  /**
   * Builds one grouped SELECT for aggregate(). Group keys and filters go
   * through the same converter as find(), and every value is a parameter.
   * Output names are quoted identifiers; sort names must be outputs.
   */
  buildAggregateQueryAndParams(
    collection: string,
    query: Record<string, any>,
    options: AggregateOptions,
    jsonField: string = "data",
  ): { sql: string; params: any[] } {
    const column = this.#quoteIdent(jsonField);
    const text = (path: string) =>
      `${column} #>> ${this.#buildJsonbPath(path)}`;
    const numeric = (path: string) => `(${text(path)})::numeric`;

    const by = Object.entries(options.by ?? {});
    const fields = Object.entries(options.fields);
    if (!fields.length)
      throw new QueryError("aggregate requires at least one field");

    let params: any[] = [];
    const columns: string[] = [];
    for (const [name, key] of by) {
      const expression =
        typeof key === "string"
          ? text(key)
          : `to_timestamp(${numeric(key.$day)} / 1000)::date::text`;
      columns.push(`${expression} AS ${this.#quoteIdent(name)}`);
    }
    for (const [name, spec] of fields) {
      const { where, ...op } = spec as Record<string, any>;
      let expression: string;
      if ("$count" in op) expression = "COUNT(*)";
      else if ("$countDistinct" in op)
        expression = `COUNT(DISTINCT ${text(op.$countDistinct)})`;
      else if ("$sum" in op) expression = `SUM(${numeric(op.$sum)})`;
      else if ("$min" in op) expression = `MIN(${numeric(op.$min)})`;
      else if ("$max" in op) expression = `MAX(${numeric(op.$max)})`;
      // stored size of the whole document, as octet_length(jsonb::text)
      else if ("$bytes" in op)
        expression = `SUM(octet_length(${column}::text))`;
      else throw new QueryError(`aggregate field ${name} has no operator`);
      if (where && Object.keys(where).length) {
        const built = this.buildWhereClauseAndParams(where, jsonField, params);
        params = built.params;
        if (built.whereClause) expression += ` FILTER (${built.whereClause})`;
      }
      // SUM over no rows is NULL; report 0 like COUNT does
      if ("$sum" in op || "$bytes" in op)
        expression = `COALESCE(${expression}, 0)`;
      columns.push(`${expression} AS ${this.#quoteIdent(name)}`);
    }

    const built = this.buildWhereClauseAndParams(query, jsonField, params);
    let sql = `SELECT ${columns.join(", ")} FROM ${this.#quoteIdent(collection)} ${built.whereClause}`;
    if (by.length)
      sql += ` GROUP BY ${by.map((_, index) => index + 1).join(", ")}`;

    const outputs = new Set([...by, ...fields].map(([name]) => name));
    const sort = Object.entries(options.sort ?? {});
    if (sort.length) {
      sql += ` ORDER BY ${sort
        .map(([name, direction]) => {
          if (!outputs.has(name))
            throw new QueryError(`aggregate sort ${name} is not an output`);
          return `${this.#quoteIdent(name)} ${direction === 1 ? "ASC" : "DESC"} NULLS LAST`;
        })
        .join(", ")}`;
    }
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1)
        throw new QueryError("aggregate limit must be a positive integer");
      sql += ` LIMIT ${options.limit}`;
    }
    return { sql: sql.trim(), params: built.params };
  }

  /**
   * Converts MongoDB update operators to a parameterized PostgreSQL JSONB SET expression.
   * Placeholders continue after `params`, which are returned first, so the
   * expression shares one statement with a filter without renumbering.
   * @returns Object containing { expression: string, params: any[] } or null.
   */
  buildUpdateSetExpressionAndParams(
    updateOps: Record<string, any>,
    jsonField: string = "data",
    params: any[] = [],
  ): { expression: string; params: any[] } | null {
    this.#params = [...params];
    let currentExpression = this.#quoteIdent(jsonField);
    let appliedOps = 0;
    for (const [operator, ops] of Object.entries(updateOps)) {
      if (operator === "$set") {
        if (typeof ops !== "object" || ops === null) continue;
        for (const [fieldPath, value] of Object.entries(ops)) {
          const pathArray = this.#buildJsonbPath(fieldPath);
          const stringifiedValue = JSON.stringify(value);
          const valuePlaceholder = this.#addParam(stringifiedValue);
          const jsonbExpression = `${valuePlaceholder}::jsonb`;
          // jsonb_set_lax creates only the last path segment: a nested path
          // whose parent object is missing leaves the document unchanged
          currentExpression = `jsonb_set_lax(${currentExpression}::jsonb, ${pathArray}, ${jsonbExpression}, true)`;
          appliedOps++;
        }
      } else if (operator === "$inc") {
        if (typeof ops !== "object" || ops === null) continue;
        for (const [fieldPath, increment] of Object.entries(ops)) {
          if (typeof increment !== "number")
            throw new QueryError(`$inc ${fieldPath} must be a number`);
          const pathArray = this.#buildJsonbPath(fieldPath);
          const parts = fieldPath.split(".");
          let currentAccessPath = this.#quoteIdent(jsonField);
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const quotedPart = this.#quoteLiteral(part);
            currentAccessPath += `->${quotedPart}`;
          }
          const incrementPlaceholder = this.#addParam(increment);
          const incrementExpression = `to_jsonb(COALESCE((${currentAccessPath})::numeric, 0) + ${incrementPlaceholder}::numeric)`;
          // Use jsonb_set_lax here too for consistency and potential nested increments
          currentExpression = `jsonb_set_lax(${currentExpression}::jsonb, ${pathArray}, ${incrementExpression}, true)`;
          appliedOps++;
        }
      } else if (operator === "$min") {
        // keep the smaller number: set when the stored value is missing,
        // null, or larger. LEAST ignores NULL, so a missing value takes the
        // operand. Numbers only; a stored non-number fails the cast.
        if (typeof ops !== "object" || ops === null) continue;
        for (const [fieldPath, value] of Object.entries(ops)) {
          if (typeof value !== "number")
            throw new QueryError(`$min ${fieldPath} must be a number`);
          const pathArray = this.#buildJsonbPath(fieldPath);
          const placeholder = this.#addParam(value);
          const stored = `(${this.#quoteIdent(jsonField)} #>> ${pathArray})::numeric`;
          currentExpression = `jsonb_set_lax(${currentExpression}::jsonb, ${pathArray}, to_jsonb(LEAST(${stored}, ${placeholder}::numeric)), true)`;
          appliedOps++;
        }
      } else if (operator === "$setIfNull") {
        // set only when the stored value is missing or JSON null
        if (typeof ops !== "object" || ops === null) continue;
        for (const [fieldPath, value] of Object.entries(ops)) {
          const pathArray = this.#buildJsonbPath(fieldPath);
          const placeholder = this.#addParam(JSON.stringify(value));
          const stored = `${this.#quoteIdent(jsonField)} #> ${pathArray}`;
          currentExpression = `jsonb_set_lax(${currentExpression}::jsonb, ${pathArray}, COALESCE(NULLIF(${stored}, 'null'::jsonb), ${placeholder}::jsonb), true)`;
          appliedOps++;
        }
      } else {
        throw new QueryError(`unsupported update operator: ${operator}`);
      }
    }
    return appliedOps > 0
      ? { expression: currentExpression, params: this.#params }
      : null;
  }

  /**
   * builds the condition string for the where clause
   */
  #buildWhereClause(query: Record<string, any>, jsonField: string): string {
    if (!query || Object.keys(query).length === 0) return "";
    return this.#processQueryObject(query, jsonField);
  }

  // A sub-filter that folds to a constant references none of the parameters
  // bound while compiling it; drop them so placeholders and params stay
  // aligned.
  #fold(compile: () => string): string {
    const mark = this.#params.length;
    const clause = compile();
    if (!clause || clause === "TRUE" || clause === "FALSE")
      this.#params.length = mark;
    return clause;
  }

  #processQueryObject(
    query: Record<string, any>,
    jsonField: string,
    parentPath = "",
  ): string {
    return this.#fold(() => this.#queryObject(query, jsonField, parentPath));
  }

  #queryObject(
    query: Record<string, any>,
    jsonField: string,
    parentPath: string,
  ): string {
    const clauses: string[] = [];
    let isTrueResult = false;

    for (const [key, value] of Object.entries(query)) {
      if (key === "$where") throw new QueryError("$where is not supported");
      if (key === "$text") {
        // { $text: { $search: "words" } } -> websearch_to_tsquery match over
        // SchemaOptions.textFields. Without textFields it throws rather than
        // matching every row.
        if (!this.#textFields?.length)
          throw new QueryError("$text requires SchemaOptions.textFields");
        if (typeof value?.$search !== "string")
          throw new QueryError("$text requires { $search: string }");
        this.#textQuery = `websearch_to_tsquery('english', ${this.#addParam(value.$search)})`;
        clauses.push(`${this.#textVector(jsonField)} @@ ${this.#textQuery}`);
        continue;
      }

      if (this.#isLogicalOperator(key)) {
        const currentJsonFieldContext = parentPath || jsonField;
        const logicalClause = this.#fold(() =>
          this.#handleLogicalOperator(
            key,
            value,
            currentJsonFieldContext,
            parentPath,
          ),
        );
        if (logicalClause) {
          // Handle TRUE/FALSE returns from logical operators
          if (logicalClause === "TRUE") {
            isTrueResult = true;
            // Don't add 'TRUE' to clauses array, just note it
            continue;
          } else if (logicalClause === "FALSE") {
            return "FALSE"; // Short-circuit
          }
          clauses.push(logicalClause);
        } // else: operator returned '' (empty string), ignore
        continue;
      }

      if (!key.startsWith("$")) {
        let fieldClause = "";
        let valueObjectForWrappingCheck: any = null;
        // Track if a comparison operator explicitly returned 'TRUE' (like $nin:[])
        let comparisonReturnedTrue = false;

        if (key.includes(".")) {
          const parts = key.split(".");
          let currentJsonPath = parentPath ? parentPath : jsonField;
          let currentAccessPath = "";
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            const isNumericIndex = /^\d+$/.test(part);
            const basePath = currentJsonPath;
            if (isNumericIndex) {
              currentJsonPath += `->${part}`;
            } else {
              currentJsonPath += `->'${this.#escapeKey(part)}'`;
            }
            if (isLastPart) {
              if (isNumericIndex) {
                currentAccessPath = `${basePath}->>${part}`;
              } else {
                currentAccessPath = `${basePath}->>'${this.#escapeKey(part)}'`;
              }
            }
          }
          if (this.#isOperatorObject(value)) {
            fieldClause = this.#processFieldOperators(
              value,
              currentAccessPath,
              currentJsonPath,
            );
            valueObjectForWrappingCheck = value;
            // Check if the processFieldOperators resulted in TRUE (e.g. from $nin:[])
            if (fieldClause === "TRUE") comparisonReturnedTrue = true;
          } else {
            fieldClause = this.#createEqualityCondition(
              currentAccessPath,
              currentJsonPath,
              value,
            );
          }
        } else {
          const ek = this.#escapeKey(key);
          const currentJsonPath = parentPath
            ? `${parentPath}->'${ek}'`
            : `${jsonField}->'${ek}'`;
          const currentAccessPath = parentPath
            ? `${parentPath}->>'${ek}'`
            : `${jsonField}->>'${ek}'`;

          if (this.#isOperatorObject(value)) {
            fieldClause = this.#processFieldOperators(
              value,
              currentAccessPath,
              currentJsonPath,
            );
            valueObjectForWrappingCheck = value;
            // Check if the processFieldOperators resulted in TRUE (e.g. from $nin:[])
            if (fieldClause === "TRUE") comparisonReturnedTrue = true;
          } else {
            fieldClause = this.#createEqualityCondition(
              currentAccessPath,
              currentJsonPath,
              value,
            );
          }
        }

        if (fieldClause && fieldClause !== "TRUE") {
          if (valueObjectForWrappingCheck) {
            const operatorKeys = Object.keys(
              valueObjectForWrappingCheck,
            ).filter((k) => k !== "$options");
            if (operatorKeys.length > 1 && fieldClause !== "FALSE") {
              fieldClause = `(${fieldClause})`;
            }
          }
          clauses.push(fieldClause);
        }
        // If the comparison operator returned 'TRUE', mark the overall result as potentially TRUE
        if (comparisonReturnedTrue) {
          isTrueResult = true;
        }
      } else {
        throw new QueryError(`unsupported operator: ${key}`);
      }
    }

    if (clauses.includes("FALSE")) return "FALSE";
    // Filter out TRUE clauses before joining, but respect isTrueResult
    const validClauses = clauses.filter((c) => c && c !== "TRUE");

    if (validClauses.length === 0) {
      // Return TRUE if isTrueResult was set (e.g. $nin:[])
      // OR if a logical operator returned TRUE (handled within logical operator logic)
      return isTrueResult ? "TRUE" : "";
    }

    const joined = validClauses.join(" AND ");
    return joined;
  }

  #processFieldOperators(
    operators: Record<string, any>,
    accessPath: string,
    jsonPath: string,
  ): string {
    return this.#fold(() =>
      this.#fieldOperators(operators, accessPath, jsonPath),
    );
  }

  #fieldOperators(
    operators: Record<string, any>,
    accessPath: string,
    jsonPath: string,
  ): string {
    const fieldClauses: string[] = [];
    let operatorReturnedTrue = false; // Track if any operator returns TRUE

    if ("$options" in operators && !("$regex" in operators))
      throw new QueryError("$options requires $regex");

    for (const [op, operand] of Object.entries(operators)) {
      const clause =
        op === "$not"
          ? this.#handleNotOperator(operand, accessPath, jsonPath)
          : this.#handleComparisonOperator(
              op,
              operand,
              accessPath,
              jsonPath,
              operators.$options as string | undefined,
            );
      // the operators of one field are ANDed, so one FALSE decides
      if (clause === "FALSE") return "FALSE";
      // Check if the operator returned TRUE
      if (clause === "TRUE") {
        operatorReturnedTrue = true;
        // Don't add 'TRUE' to clauses, just note it.
        continue;
      }
      if (clause) {
        // Add non-empty, non-TRUE clauses
        fieldClauses.push(clause);
      }
    }
    // If any operator returned TRUE and there are no other clauses, return TRUE
    if (operatorReturnedTrue && fieldClauses.length === 0) {
      return "TRUE";
    }
    // If there are clauses, join them; otherwise return empty or FALSE if applicable (though FALSE handled implicitly)
    return fieldClauses.join(" AND ");
  }

  #createEqualityCondition(
    accessPath: string,
    jsonPath: string,
    value: any,
  ): string {
    if (value === null) {
      // Fix: Use jsonPath directly for null checks
      return `(${jsonPath} IS NULL OR ${jsonPath} = 'null'::jsonb)`;
    }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      return `${jsonPath}::jsonb = '{}'::jsonb`;
    }

    const valuePlaceholder = this.#addParam(value);

    if (Array.isArray(value)) {
      return `${jsonPath}::jsonb = ${valuePlaceholder}::jsonb`;
    }
    if (typeof value === "boolean") {
      return `(${accessPath})::boolean = ${valuePlaceholder}`;
    }
    if (typeof value === "number") {
      const cast = Number.isInteger(value) ? "integer" : "numeric";
      return `(${accessPath})::${cast} = ${valuePlaceholder}`;
    }
    return `${accessPath} = ${valuePlaceholder}`;
  }

  #handleComparisonOperator(
    operator: string,
    operand: any,
    accessPath: string,
    jsonPath: string, // Ensure jsonPath is consistently available
    regexOptions?: string,
  ): string {
    const bind = (val: any) => this.#bindValue(val);
    const numericAccessPath = `(${accessPath})::numeric`;
    const booleanAccessPath = `(${accessPath})::boolean`;

    switch (operator) {
      case "$eq":
        if (operand === undefined) return `${jsonPath} IS NULL`; // Use jsonPath
        return this.#createEqualityCondition(accessPath, jsonPath, operand); // Passes jsonPath

      case "$ne": {
        if (operand === undefined) return `${jsonPath} IS NOT NULL`; // Use jsonPath
        if (operand === null) {
          // Fix: Use jsonPath directly for null checks
          return `(${jsonPath} IS NOT NULL AND ${jsonPath} != 'null'::jsonb)`;
        }
        if (
          typeof operand === "object" &&
          !Array.isArray(operand) &&
          Object.keys(operand).length === 0
        ) {
          return `${jsonPath}::jsonb != '{}'::jsonb`; // Use jsonPath
        }

        const neValuePlaceholder = this.#addParam(operand);

        if (typeof operand === "boolean") {
          return `(${accessPath})::boolean IS DISTINCT FROM ${neValuePlaceholder}`;
        }
        if (Array.isArray(operand)) {
          return `${jsonPath}::jsonb != ${neValuePlaceholder}::jsonb`; // Use jsonPath
        }
        if (typeof operand === "number") {
          const cast = Number.isInteger(operand) ? "integer" : "numeric";
          return `(${accessPath})::${cast} IS DISTINCT FROM ${neValuePlaceholder}`;
        }
        return `${accessPath} IS DISTINCT FROM ${neValuePlaceholder}`;
      }

      case "$gt":
        return typeof operand === "number"
          ? `${numericAccessPath} > ${bind(operand)}`
          : `${accessPath} > ${bind(operand)}`;

      case "$gte":
        return typeof operand === "number"
          ? `${numericAccessPath} >= ${bind(operand)}`
          : `${accessPath} >= ${bind(operand)}`;

      case "$lt":
        return typeof operand === "number"
          ? `${numericAccessPath} < ${bind(operand)}`
          : `${accessPath} < ${bind(operand)}`;

      case "$lte":
        return typeof operand === "number"
          ? `${numericAccessPath} <= ${bind(operand)}`
          : `${accessPath} <= ${bind(operand)}`;

      case "$in": {
        if (!Array.isArray(operand))
          throw new QueryError("$in requires an array");
        if (operand.length === 0) return "FALSE";
        const hasNull = operand.includes(null);
        const nonNullOperands = operand.filter((v) => v !== null);
        if (nonNullOperands.length === 0) {
          return hasNull
            ? `(${jsonPath} IS NULL OR ${jsonPath} = 'null'::jsonb)`
            : "FALSE";
        }

        // Revert Fix 3: Explicitly handle integer and number groups again
        const groups: {
          integer: number[];
          number: number[];
          boolean: boolean[];
          string: string[];
          object: any[];
        } = { integer: [], number: [], boolean: [], string: [], object: [] };
        nonNullOperands.forEach((val) => {
          const type = typeof val;
          if (type === "number") {
            // Separate integer and float/numeric using string check for decimal
            if (String(val).includes(".")) {
              groups.number.push(val);
            } else {
              groups.integer.push(val);
            }
          } else if (type === "boolean") groups.boolean.push(val);
          else if (type === "string") groups.string.push(val);
          else if (type === "object") groups.object.push(val);
        });

        const conditions: string[] = [];
        // Check and add conditions for each type group if it has elements
        if (groups.integer.length > 0)
          conditions.push(
            `(${accessPath})::integer = ANY(${this.#addParam(groups.integer)})`,
          );
        if (groups.number.length > 0)
          conditions.push(
            `(${accessPath})::numeric = ANY(${this.#addParam(groups.number)})`,
          );
        if (groups.boolean.length > 0)
          conditions.push(
            `(${accessPath})::boolean = ANY(${this.#addParam(groups.boolean)})`,
          );
        if (groups.string.length > 0)
          conditions.push(
            `${accessPath} = ANY(${this.#addParam(groups.string)})`,
          );
        if (groups.object.length > 0)
          conditions.push(
            `${jsonPath}::jsonb = ANY(${this.#addParam(groups.object)}::jsonb[])`,
          );

        let nonNullCondition = conditions.join(" OR ");
        if (conditions.length > 1) {
          nonNullCondition = `(${nonNullCondition})`;
        }

        if (hasNull) {
          const nullCheck = `(${jsonPath} IS NULL OR ${jsonPath} = 'null'::jsonb)`;
          // Fix 2: Wrap nonNullCondition explicitly to match test expectations
          return nonNullCondition
            ? `((${nonNullCondition}) OR ${nullCheck})`
            : nullCheck;
        }

        return nonNullCondition || "FALSE";
      }

      case "$nin": {
        if (!Array.isArray(operand))
          throw new QueryError("$nin requires an array");
        if (operand.length === 0) return "TRUE";
        const hasNull = operand.includes(null);
        const nonNullOperands = operand.filter((v) => v !== null);
        if (nonNullOperands.length === 0) {
          return hasNull
            ? `(${jsonPath} IS NOT NULL AND ${jsonPath} != 'null'::jsonb)`
            : "TRUE";
        }
        const conditions: string[] = [];
        const groups: { [type: string]: any[] } = {};
        nonNullOperands.forEach((val) => {
          groups[typeof val] = [...(groups[typeof val] || []), val];
        });
        for (const [type, values] of Object.entries(groups)) {
          const valuePlaceholder = this.#addParam(values);
          let condition = "";
          if (type === "number") {
            const cast = values.some((v) => !Number.isInteger(v))
              ? "numeric"
              : "integer";
            condition = `(${accessPath})::${cast} != ALL(${valuePlaceholder})`;
          } else if (type === "boolean") {
            condition = `(${accessPath})::boolean != ALL(${valuePlaceholder})`;
          } else if (type === "object") {
            condition = `${jsonPath}::jsonb <> ALL(${valuePlaceholder}::jsonb[])`;
          } else {
            condition = `${accessPath} != ALL(${valuePlaceholder})`;
          }
          conditions.push(condition);
        }
        let nonNullCondition = conditions.join(" AND ");
        if (conditions.length > 1) {
          nonNullCondition = `(${nonNullCondition})`;
        }
        if (hasNull) {
          const nullCheck = `${jsonPath} IS NOT NULL AND ${jsonPath} != 'null'::jsonb`;
          return `(${nonNullCondition} AND (${nullCheck}))`;
        }
        return nonNullCondition;
      }

      case "$exists":
        if (typeof operand !== "boolean" && operand !== 0 && operand !== 1)
          throw new QueryError("$exists requires a boolean");
        return operand ? `${jsonPath} IS NOT NULL` : `${jsonPath} IS NULL`;

      case "$regex": {
        let pattern = operand;
        let flags = regexOptions || "";

        if (
          Array.isArray(operand) &&
          operand.length === 2 &&
          typeof operand[0] === "string" &&
          typeof operand[1] === "string"
        ) {
          pattern = operand[0];
          flags = operand[1];
        } else if (
          typeof operand === "string" &&
          operand.startsWith("/") &&
          operand.lastIndexOf("/") > 0
        ) {
          const match = operand.match(/^\/(.+)\/([gimyus]*)$/);
          if (match) {
            pattern = match[1];
            flags = match[2];
          }
        }

        const op = flags.includes("i") ? "~*" : "~";
        return `${accessPath} ${op} ${bind(pattern)}`;
      }

      case "$mod":
        if (
          Array.isArray(operand) &&
          operand.length === 2 &&
          typeof operand[0] === "number" &&
          typeof operand[1] === "number"
        ) {
          return `${numericAccessPath} % ${bind(operand[0])} = ${bind(operand[1])}`;
        }
        throw new QueryError("$mod requires [divisor, remainder]");

      case "$size":
        if (
          typeof operand !== "number" ||
          !Number.isInteger(operand) ||
          operand < 0
        )
          throw new QueryError("$size requires a non-negative integer");
        return `(jsonb_typeof(${jsonPath}) = 'array' AND jsonb_array_length(${jsonPath}) = ${operand})`;

      case "$all":
        if (!Array.isArray(operand))
          throw new QueryError("$all requires an array");
        // an empty $all matches nothing; `@> '[]'` would match every array
        if (operand.length === 0) return "FALSE";
        return `${jsonPath} @> ${bind(operand)}::jsonb`;

      case "$elemMatch": {
        if (
          typeof operand !== "object" ||
          operand === null ||
          Array.isArray(operand)
        )
          throw new QueryError("$elemMatch requires an object");

        const keys = Object.keys(operand);
        const allKeysAreOperators = keys.every((k) => k.startsWith("$"));
        const containsLogicalOperator = keys.some((k) =>
          this.#isLogicalOperator(k),
        );
        const isPrimitiveMatch =
          allKeysAreOperators && !containsLogicalOperator;

        // each element is a jsonb value: operators on the element itself
        // read its text as `elem #>> '{}'`, field filters read `elem->'key'`
        const alias = "elem";
        const elemMatchConditions = isPrimitiveMatch
          ? this.#processFieldOperators(operand, `(${alias} #>> '{}')`, alias)
          : this.#processQueryObject(operand, alias, "");

        if (elemMatchConditions === "FALSE") return "FALSE";
        if (!elemMatchConditions || elemMatchConditions === "TRUE") {
          // If conditions are empty or TRUE, just check if it's a non-empty array
          return `(${jsonPath} IS NOT NULL AND jsonb_typeof(${jsonPath}) = 'array' AND jsonb_array_length(${jsonPath}) > 0)`;
        }

        return `EXISTS (SELECT 1 FROM jsonb_array_elements(${jsonPath}) as ${alias} WHERE ${elemMatchConditions})`;
      }

      case "$type": {
        const typeMapping: Record<string, string> = {
          string: "string",
          number: "number",
          boolean: "boolean",
          array: "array",
          object: "object",
          null: "null",
        };
        if (!Object.hasOwn(typeMapping, operand))
          throw new QueryError(`unsupported $type: ${operand}`);
        const pgType = typeMapping[operand];
        return `jsonb_typeof(${jsonPath}) = ${bind(pgType)}`;
      }

      case "$ieq":
        // case-insensitive equality; lower(data->>'f') is also the form an
        // expression index on lower() matches
        if (typeof operand !== "string")
          throw new QueryError("$ieq requires a string");
        return `lower(${accessPath}) = lower(${this.#addParam(operand)})`;

      case "$options":
        // flags for a sibling $regex, read there
        return "";

      default:
        throw new QueryError(`unsupported operator: ${operator}`);
    }
  }

  #handleLogicalOperator(
    operator: string,
    operands: any,
    jsonField: string,
    parentPath: string,
  ): string {
    switch (operator) {
      case "$and":
      case "$or":
      case "$nor": {
        if (!Array.isArray(operands))
          throw new QueryError(`${operator} requires an array`);
        if (operands.length === 0)
          throw new QueryError(`${operator} requires a non-empty array`);
        // every member folds to a clause, TRUE (no condition), or FALSE
        const clauses = operands.map((subQuery) => {
          if (
            typeof subQuery !== "object" ||
            subQuery === null ||
            Array.isArray(subQuery)
          )
            throw new QueryError(`${operator} members must be objects`);
          return (
            this.#processQueryObject(subQuery, jsonField, parentPath) || "TRUE"
          );
        });
        const join = (decides: string, neutral: string, joiner: string) => {
          if (clauses.includes(decides)) return decides;
          const rest = clauses.filter((c) => c !== neutral);
          if (rest.length === 0) return neutral;
          return rest.length === 1 ? rest[0] : `(${rest.join(joiner)})`;
        };
        if (operator === "$and") return join("FALSE", "TRUE", " AND ");
        const anyOf = join("TRUE", "FALSE", " OR ");
        if (operator === "$or") return anyOf;
        if (anyOf === "TRUE") return "FALSE";
        if (anyOf === "FALSE") return "TRUE";
        return `NOT (${anyOf})`;
      }
      case "$not": {
        if (
          typeof operands !== "object" ||
          operands === null ||
          Array.isArray(operands)
        )
          throw new QueryError("$not requires an object");
        const innerCondition = this.#processQueryObject(
          operands as Record<string, any>,
          jsonField,
          parentPath,
        );

        if (!innerCondition || innerCondition === "TRUE") return "FALSE";
        if (innerCondition === "FALSE") return "TRUE";
        return `NOT (${innerCondition})`;
      }
      default:
        return "";
    }
  }

  #handleNotOperator(
    operand: any,
    accessPath: string,
    jsonPath: string,
  ): string {
    if (
      typeof operand !== "object" ||
      operand === null ||
      Array.isArray(operand) ||
      Object.keys(operand).length === 0
    )
      throw new QueryError("$not requires a non-empty object");
    // Pass jsonPath down for potential null checks within operand
    const innerCondition = this.#processFieldOperators(
      operand,
      accessPath,
      jsonPath,
    );

    if (!innerCondition || innerCondition === "TRUE") {
      return "FALSE";
    }
    if (innerCondition === "FALSE") {
      return "TRUE";
    }
    return `NOT (${innerCondition})`;
  }

  #isLogicalOperator(key: string): boolean {
    return ["$and", "$or", "$nor", "$not"].includes(key);
  }

  #isOperatorObject(value: any): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key.startsWith("$"))
    );
  }

  // Bind an operand as a parameter. Operands can come from client-supplied
  // filter JSON, so none may be spliced into the SQL text. Arrays and objects
  // bind as their JSON text.
  #bindValue(value: any): string {
    if (value === undefined) return this.#addParam(null);
    if (typeof value === "object" && value !== null)
      return this.#addParam(JSON.stringify(value));
    return this.#addParam(value);
  }

  #buildSortClause(
    sort: Record<string, SortDirection> | undefined,
    jsonField: string,
  ): string {
    if (!sort || Object.keys(sort).length === 0) {
      return "";
    }
    const sortClauses = Object.entries(sort).map(([key, direction]) => {
      // Convert 1 / -1 back to ASC / DESC
      const pgDirection = direction === 1 ? "ASC" : "DESC";

      if (key === "$natural") return `id ${pgDirection}`;
      if (key === "$textScore") {
        if (!this.#textQuery)
          throw new QueryError("$textScore sort requires a $text filter");
        return `ts_rank(${this.#textVector(jsonField)}, ${this.#textQuery}) ${pgDirection}`;
      }

      let accessPath = "";
      if (key.includes(".")) {
        const parts = key.split(".");
        let currentPath = jsonField;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const isLastPart = i === parts.length - 1;
          const isNumericIndex = /^\d+$/.test(part);

          if (isNumericIndex) {
            currentPath += `->${part}`;
          } else {
            currentPath += `->'${this.#escapeKey(part)}'`;
          }

          if (isLastPart) {
            // sort on the jsonb value (`->`), not its text form (`->>`):
            // text extraction ordered numbers lexicographically ("9" > "80")
            accessPath = currentPath;
          }
        }
        if (!accessPath) accessPath = `${jsonField}->'${this.#escapeKey(key)}'`;
      } else {
        accessPath = `${jsonField}->'${this.#escapeKey(key)}'`;
      }

      return `${accessPath} ${pgDirection} NULLS LAST`;
    });
    return ` ORDER BY ${sortClauses.join(", ")}`;
  }

  #buildJsonbPath(fieldPath: string): string {
    // Convert dot notation 'a.b.c' to Postgres jsonb path literal '{ "a", "b", "c" }'
    // Use JSON.stringify for robust quoting of path segments
    const segments = fieldPath.split(".").map((p) => JSON.stringify(p));
    // Return the literal directly, wrapped in single quotes for SQL; embedded
    // single quotes are doubled so a key cannot end the literal
    return `'{${segments.join(",").replace(/'/g, "''")}}'`;
  }

  // find({ select }): only the named top-level fields, rebuilt as the json
  // column so row handling stays the same
  #projection(fields: string[], jsonField: string): string {
    if (!Array.isArray(fields) || !fields.length)
      throw new QueryError("select requires at least one field");
    // jsonb_build_object takes at most 100 arguments, two per field
    if (fields.length > 50)
      throw new QueryError("select takes at most 50 fields");
    const column = this.#quoteIdent(jsonField);
    const pairs = fields.map((field) => {
      if (typeof field !== "string" || field.includes("."))
        throw new QueryError(`select takes top-level fields: ${field}`);
      const key = this.#escapeKey(field);
      return `'${key}', ${column}->'${key}'`;
    });
    return `jsonb_build_object(${pairs.join(", ")}) AS ${column}`;
  }

  // the tsvector $text matches and ranks against. Kept textually identical
  // to the expression a GIN index would be built on, so the index serves it.
  #textVector(jsonField: string): string {
    const parts = (this.#textFields ?? []).map(
      (field) => `coalesce(${jsonField}->>'${this.#escapeKey(field)}', '')`,
    );
    return `to_tsvector('english', ${parts.join(" || ' ' || ")})`;
  }

  #quoteIdent(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  #quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  // escape a user-supplied JSON key for safe interpolation between single
  // quotes in a jsonb path (data->'<key>'). doubles embedded single quotes so
  // a filter/sort key can never break out of the string literal (SQL injection).
  #escapeKey(key: string): string {
    return key.replace(/'/g, "''");
  }
}
