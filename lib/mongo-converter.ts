import { isDeepStrictEqual } from 'util'; // Use built-in util for deep comparison
import type { SortDirection } from './types'; // Import SortDirection type if it's not already imported (assuming it's in ./types)

export class MongoToPG {
  // Internal state for parameters during a single conversion
  #params: any[] = [];

  // Helper to add a parameter and return its placeholder
  #addParam(value: any): string {
    this.#params.push(value);
    return `$${this.#params.length}`;
  }

  /**
   * Converts MongoDB query object to parameterized SQL query parts for SELECT.
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
    } = {}
  ): { sql: string; params: any[] } {
    this.#params = []; // Reset parameters for this conversion
    const {
      jsonField = 'data',
      schema: schemaOption,
      limit,
      offset, // Use offset
      sort
    } = options;

    const tableRef = options.schema ? `${this.#quoteIdent(options.schema)}.${this.#quoteIdent(collection)}` : this.#quoteIdent(collection);
    const whereClause = this.#buildWhereClause(query, jsonField);

    let sqlQuery = `SELECT ${this.#quoteIdent(jsonField)} FROM ${tableRef}`;
    
    // Fix 1: Be absolutely explicit about checking for 'TRUE' string
    if (whereClause === 'TRUE') {
      sqlQuery += ` WHERE TRUE`; 
    } else if (whereClause) { // Check if not empty string
      sqlQuery += ` WHERE ${whereClause}`;
    }

    if (sort && Object.keys(sort).length > 0) sqlQuery += this.#buildSortClause(sort, jsonField);
    if (limit !== undefined && limit > 0) sqlQuery += ` LIMIT ${limit}`;
    if (offset !== undefined && offset > 0) sqlQuery += ` OFFSET ${offset}`; // Handle offset

    return { sql: sqlQuery.trim(), params: this.#params };
  }

  /**
   * Builds only the WHERE clause and parameters from a MongoDB query object.
   * @returns Object containing { whereClause: string (e.g., "WHERE ..."), params: any[] }
   */
  buildWhereClauseAndParams(
    query: Record<string, any>,
    jsonField: string = 'data'
  ): { whereClause: string, params: any[] } {
      this.#params = []; // Reset parameters
      const whereClause = this.#buildWhereClause(query, jsonField);
      // Return clause with "WHERE" prefix if not empty
      return { whereClause: whereClause ? `WHERE ${whereClause}` : '', params: this.#params };
  }

  /**
   * Converts MongoDB update operators to a parameterized PostgreSQL JSONB SET expression.
   * @returns Object containing { expression: string, params: any[] } or null.
   */
  buildUpdateSetExpressionAndParams(
      updateOps: Record<string, any>,
      jsonField: string = 'data'
  ): { expression: string, params: any[] } | null {
    this.#params = []; 
    let currentExpression = this.#quoteIdent(jsonField);
    let appliedOps = 0;
    for (const [operator, ops] of Object.entries(updateOps)) {
      if (operator === '$set') {
        if (typeof ops !== 'object' || ops === null) continue;
        for (const [fieldPath, value] of Object.entries(ops)) {
          const pathArray = this.#buildJsonbPath(fieldPath);
          const stringifiedValue = JSON.stringify(value);
          const valuePlaceholder = this.#addParam(stringifiedValue); 
          const jsonbExpression = `${valuePlaceholder}::jsonb`;
          // Use jsonb_set_lax to create intermediate objects/arrays if they don't exist
          currentExpression = `jsonb_set_lax(${currentExpression}::jsonb, ${pathArray}, ${jsonbExpression}, true)`;
          appliedOps++;
        }
      } else if (operator === '$inc') {
         if (typeof ops !== 'object' || ops === null) continue;
         for (const [fieldPath, increment] of Object.entries(ops)) {
           if (typeof increment !== 'number') {
             console.warn(`Unsupported $inc value for path ${fieldPath}. Must be a number.`);
             continue;
           }
           const pathArray = this.#buildJsonbPath(fieldPath);
           const parts = fieldPath.split('.');
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
      } else {
        console.warn(`Unsupported update operator: ${operator}`);
      }
    }
    return appliedOps > 0 ? { expression: currentExpression, params: this.#params } : null;
  }

  /**
   * builds the condition string for the where clause
   */
  #buildWhereClause(query: Record<string, any>, jsonField: string): string {
    if (!query || Object.keys(query).length === 0) return '';
    return this.#processQueryObject(query, jsonField);
  }

  #processQueryObject(query: Record<string, any>, jsonField: string, parentPath = ''): string {
    const clauses: string[] = [];
    let isTrueResult = false; 

    for (const [key, value] of Object.entries(query)) {
      if (key === '$where') {
        console.error('CRITICAL: Unsupported and potentially dangerous operator: $where. Query conversion aborted.');
        throw new Error('$where operator is not supported due to security risks.');
      }
      if (key === '$text') {
        console.warn('Unsupported operator: $text (requires FTS configuration). Returning TRUE.');
        isTrueResult = true;
        continue;
      }
      
      if (this.#isLogicalOperator(key)) {
        const currentJsonFieldContext = parentPath || jsonField;
        const logicalClause = this.#handleLogicalOperator(key, value, currentJsonFieldContext, parentPath);
        if (logicalClause) {
             // Handle TRUE/FALSE returns from logical operators
             if (logicalClause === 'TRUE') { 
                 isTrueResult = true; 
                 // Don't add 'TRUE' to clauses array, just note it
                 continue; 
             } else if (logicalClause === 'FALSE') {
                 return 'FALSE'; // Short-circuit
             }
             clauses.push(logicalClause);
        } // else: operator returned '' (empty string), ignore
        continue;
      }
      
      if (!key.startsWith('$')) {
        let fieldClause = '';
        let valueObjectForWrappingCheck: any = null; 
        // Track if a comparison operator explicitly returned 'TRUE' (like $nin:[])
        let comparisonReturnedTrue = false;

        if (key.includes('.')) {
          const parts = key.split('.');
          let currentJsonPath = parentPath ? parentPath : jsonField;
          let currentAccessPath = '';
          for(let i = 0; i < parts.length; i++) {
              const part = parts[i];
              const isLastPart = i === parts.length - 1;
              const isNumericIndex = /^\d+$/.test(part);
              if (isNumericIndex) { currentJsonPath += `->${part}`; }
              else { currentJsonPath += `->\'${part}\'`; }
              if (isLastPart) {
                  const basePathMatch = currentJsonPath.match(/^(.*)(->\'[^\']+\'|->\d+)$/);
                  const basePath = basePathMatch ? basePathMatch[1] : (parentPath || jsonField);
                  if (isNumericIndex) { currentAccessPath = `${basePath}->>${part}`; }
                  else { currentAccessPath = `${basePath}->>\'${part}\'`; }
              }
          }
          if (this.#isOperatorObject(value)) {
            fieldClause = this.#processFieldOperators(value, currentAccessPath, currentJsonPath);
            valueObjectForWrappingCheck = value;
            // Check if the processFieldOperators resulted in TRUE (e.g. from $nin:[])
            if (fieldClause === 'TRUE') comparisonReturnedTrue = true;
          } else {
            fieldClause = this.#createEqualityCondition(currentAccessPath, currentJsonPath, value);
          }
        } else {
          const currentJsonPath = parentPath ? `${parentPath}->'${key}'` : `${jsonField}->'${key}'`;
          const currentAccessPath = parentPath ? `${parentPath}->>'${key}'` : `${jsonField}->>'${key}'`;
          
          if (this.#isOperatorObject(value)) {
            fieldClause = this.#processFieldOperators(value, currentAccessPath, currentJsonPath);
            valueObjectForWrappingCheck = value;
            // Check if the processFieldOperators resulted in TRUE (e.g. from $nin:[])
            if (fieldClause === 'TRUE') comparisonReturnedTrue = true;
          } else {
            fieldClause = this.#createEqualityCondition(currentAccessPath, currentJsonPath, value);
          }
        }

        if (fieldClause && fieldClause !== 'TRUE') {
           if (valueObjectForWrappingCheck) {
               const operatorKeys = Object.keys(valueObjectForWrappingCheck).filter(k => k !== '$options');
               if (operatorKeys.length > 1) {
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
        console.warn(`Unsupported operator used as field: ${key}`);
      }
    }

    if (clauses.includes('FALSE')) return 'FALSE'; 
    // Filter out TRUE clauses before joining, but respect isTrueResult
    const validClauses = clauses.filter(c => c && c !== 'TRUE'); 

    if (validClauses.length === 0) {
      // Return TRUE if isTrueResult was set (e.g. $text, or $nin:[]) 
      // OR if a logical operator returned TRUE (handled within logical operator logic)
      return isTrueResult ? 'TRUE' : ''; 
    }
    
    const joined = validClauses.join(' AND ');
    return joined; 
  }

  #processFieldOperators(operators: Record<string, any>, accessPath: string, jsonPath: string): string {
    const fieldClauses: string[] = [];
    let operatorReturnedTrue = false; // Track if any operator returns TRUE

    for (const [op, operand] of Object.entries(operators)) {
       if (op === '$not') {
           // Pass jsonPath correctly for null checks inside $not operand handling
           const notCondition = this.#handleNotOperator(operand, accessPath, jsonPath); 
           if (notCondition) fieldClauses.push(notCondition);
           continue;
       }
      const clause = this.#handleComparisonOperator(op, operand, accessPath, jsonPath, operators.$options as string | undefined);
      // Check if the operator returned TRUE
      if (clause === 'TRUE') {
          operatorReturnedTrue = true;
          // Don't add 'TRUE' to clauses, just note it.
          continue; 
      }
      if (clause) { // Add non-empty, non-TRUE clauses
        fieldClauses.push(clause);
      }
    }
    // If any operator returned TRUE and there are no other clauses, return TRUE
    if (operatorReturnedTrue && fieldClauses.length === 0) {
        return 'TRUE';
    }
    // If there are clauses, join them; otherwise return empty or FALSE if applicable (though FALSE handled implicitly)
    return fieldClauses.join(' AND ');
  }

  #createEqualityCondition(accessPath: string, jsonPath: string, value: any): string {
    if (value === null) {
       // Fix: Use jsonPath directly for null checks
       return `(${jsonPath} IS NULL OR ${jsonPath} = 'null'::jsonb)`;
    }
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      return `${jsonPath}::jsonb = '{}'::jsonb`;
    }

    const valuePlaceholder = this.#addParam(value);

    if (Array.isArray(value)) {
      return `${jsonPath}::jsonb = ${valuePlaceholder}::jsonb`;
    }
    if (typeof value === 'boolean') {
        return `(${accessPath})::boolean = ${valuePlaceholder}`;
    }
    if (typeof value === 'number') {
        const cast = Number.isInteger(value) ? 'integer' : 'numeric';
        return `(${accessPath})::${cast} = ${valuePlaceholder}`;
    }
    return `${accessPath} = ${valuePlaceholder}`;
  }

  #handleComparisonOperator(
    operator: string, 
    operand: any, 
    accessPath: string,
    jsonPath: string, // Ensure jsonPath is consistently available
    regexOptions?: string
  ): string {
    const sqlVal = (val: any) => this.#sqlValue(val);
    const numericAccessPath = `(${accessPath})::numeric`;
    const booleanAccessPath = `(${accessPath})::boolean`;

    switch(operator) {
      case '$eq':
        if (operand === undefined) return `${jsonPath} IS NULL`; // Use jsonPath
        return this.#createEqualityCondition(accessPath, jsonPath, operand); // Passes jsonPath
        
      case '$ne':
        if (operand === undefined) return `${jsonPath} IS NOT NULL`; // Use jsonPath
        if (operand === null) {
           // Fix: Use jsonPath directly for null checks
           return `(${jsonPath} IS NOT NULL AND ${jsonPath} != 'null'::jsonb)`;
        }
        if (typeof operand === 'object' && !Array.isArray(operand) && Object.keys(operand).length === 0) {
           return `${jsonPath}::jsonb != '{}'::jsonb`; // Use jsonPath
        }
        
        const neValuePlaceholder = this.#addParam(operand);

        if (typeof operand === 'boolean') {
            return `(${accessPath})::boolean IS DISTINCT FROM ${neValuePlaceholder}`;
        }
        if (Array.isArray(operand)) {
            return `${jsonPath}::jsonb != ${neValuePlaceholder}::jsonb`; // Use jsonPath
        }
         if (typeof operand === 'number') {
             const cast = Number.isInteger(operand) ? 'integer' : 'numeric';
             return `(${accessPath})::${cast} IS DISTINCT FROM ${neValuePlaceholder}`;
        }
        return `${accessPath} IS DISTINCT FROM ${neValuePlaceholder}`;
        
      case '$gt':
        return typeof operand === 'number' ? `${numericAccessPath} > ${sqlVal(operand)}` : `${accessPath} > ${sqlVal(operand)}`;
        
      case '$gte':
        return typeof operand === 'number' ? `${numericAccessPath} >= ${sqlVal(operand)}` : `${accessPath} >= ${sqlVal(operand)}`;
        
      case '$lt':
        return typeof operand === 'number' ? `${numericAccessPath} < ${sqlVal(operand)}` : `${accessPath} < ${sqlVal(operand)}`;
        
      case '$lte':
        return typeof operand === 'number' ? `${numericAccessPath} <= ${sqlVal(operand)}` : `${accessPath} <= ${sqlVal(operand)}`;
        
      case '$in': {
        if (!Array.isArray(operand) || operand.length === 0) return 'FALSE';
        const hasNull = operand.includes(null);
        const nonNullOperands = operand.filter(v => v !== null);
        if (nonNullOperands.length === 0) {
            return hasNull ? `(${jsonPath} IS NULL OR ${jsonPath} = 'null'::jsonb)` : 'FALSE'; 
        }
        
        // Revert Fix 3: Explicitly handle integer and number groups again
        const groups: { integer: number[], number: number[], boolean: boolean[], string: string[], object: any[] } = { integer: [], number: [], boolean: [], string: [], object: [] };
        nonNullOperands.forEach(val => {
            const type = typeof val;
            if (type === 'number') {
                // Separate integer and float/numeric using string check for decimal
                if (String(val).includes('.')) {
                    groups.number.push(val); 
                } else {
                    groups.integer.push(val); 
                }
            } else if (type === 'boolean') groups.boolean.push(val);
            else if (type === 'string') groups.string.push(val);
            else if (type === 'object') groups.object.push(val);
        });

        const conditions: string[] = [];
        // Check and add conditions for each type group if it has elements
        if(groups.integer.length > 0) conditions.push(`(${accessPath})::integer = ANY(${this.#addParam(groups.integer)})`);
        if(groups.number.length > 0) conditions.push(`(${accessPath})::numeric = ANY(${this.#addParam(groups.number)})`);
        if(groups.boolean.length > 0) conditions.push(`(${accessPath})::boolean = ANY(${this.#addParam(groups.boolean)})`);
        if(groups.string.length > 0) conditions.push(`${accessPath} = ANY(${this.#addParam(groups.string)})`);
        if(groups.object.length > 0) conditions.push(`${jsonPath}::jsonb = ANY(${this.#addParam(groups.object)}::jsonb[])`);
        
        let nonNullCondition = conditions.join(' OR ');
        if (conditions.length > 1) {
           nonNullCondition = `(${nonNullCondition})`; 
        }

        if (hasNull) {
            const nullCheck = `(${jsonPath} IS NULL OR ${jsonPath} = 'null'::jsonb)`;
            // Fix 2: Wrap nonNullCondition explicitly to match test expectations
            return nonNullCondition ? `((${nonNullCondition}) OR ${nullCheck})` : nullCheck; 
        }
        
        return nonNullCondition || 'FALSE'; 
      }
      
      case '$nin': {
         // Fix 1: Ensure $nin:[] returns 'TRUE' string
         if (Array.isArray(operand) && operand.length === 0) {
             return 'TRUE'; 
         }
         if (!Array.isArray(operand)) return 'TRUE'; 
         const hasNull = operand.includes(null);
         const nonNullOperands = operand.filter(v => v !== null);
         if (nonNullOperands.length === 0) {
             return hasNull ? `(${jsonPath} IS NOT NULL AND ${jsonPath} != 'null'::jsonb)` : 'TRUE';
         }
         const conditions: string[] = [];
         const groups: { [type: string]: any[] } = {};
         nonNullOperands.forEach(val => { groups[typeof val] = [...(groups[typeof val] || []), val]; });
         for (const [type, values] of Object.entries(groups)) {
            const valuePlaceholder = this.#addParam(values);
            let condition = '';
             if (type === 'number') {
                 const cast = values.some(v => !Number.isInteger(v)) ? 'numeric' : 'integer';
                 condition = `(${accessPath})::${cast} != ALL(${valuePlaceholder})`;
             } else if (type === 'boolean') {
                 condition = `(${accessPath})::boolean != ALL(${valuePlaceholder})`;
             } else if (type === 'object') { 
                condition = `${jsonPath}::jsonb <> ALL(${valuePlaceholder}::jsonb[])`; 
             } else {
                 condition = `${accessPath} != ALL(${valuePlaceholder})`;
             }
             conditions.push(condition);
         }
         let nonNullCondition = conditions.join(' AND '); 
         if (conditions.length > 1) {
             nonNullCondition = `(${nonNullCondition})`;
         }
         if (hasNull) {
             const nullCheck = `${jsonPath} IS NOT NULL AND ${jsonPath} != 'null'::jsonb`;
             return `(${nonNullCondition} AND (${nullCheck}))`;
         }
         return nonNullCondition;
      }
      
      case '$exists':
        return operand ? `${jsonPath} IS NOT NULL` : `${jsonPath} IS NULL`;
        
      case '$regex': {
        let pattern = operand;
        let flags = regexOptions || '';
        
        if (Array.isArray(operand) && operand.length === 2 && typeof operand[0] === 'string' && typeof operand[1] === 'string') {
           pattern = operand[0];
           flags = operand[1];
        } else if (typeof operand === 'string' && operand.startsWith('/') && operand.lastIndexOf('/') > 0) {
          const match = operand.match(/^\/(.+)\/([gimyus]*)$/);
          if (match) {
              pattern = match[1];
              flags = match[2];
          }
        }
        
        const op = flags.includes('i') ? '~*' : '~';
        return `${accessPath} ${op} ${sqlVal(pattern)}`;
      }

      case '$mod':
        if (Array.isArray(operand) && operand.length === 2 && typeof operand[0] === 'number' && typeof operand[1] === 'number') {
          return `${numericAccessPath} % ${sqlVal(operand[0])} = ${sqlVal(operand[1])}`;
        }
        console.warn('Invalid $mod operand: requires [divisor, remainder]');
        return 'FALSE';
        
      case '$size':
        if (typeof operand !== 'number' || !Number.isInteger(operand) || operand < 0) {
            console.warn('$size requires a non-negative integer');
            return 'FALSE';
        }
        return `(jsonb_typeof(${jsonPath}) = 'array' AND jsonb_array_length(${jsonPath}) = ${operand})`;

      case '$all':
        if (!Array.isArray(operand)) {
          console.warn('$all requires an array operand');
          return 'FALSE';
        }
        if (operand.length === 0) return 'TRUE';
        return `${jsonPath} @> ${sqlVal(operand)}::jsonb`;

      case '$elemMatch': { 
        if (typeof operand !== 'object' || operand === null) {
          console.warn(`Invalid $elemMatch operand: must be an object`);
          return 'FALSE';
        }
        
        const keys = Object.keys(operand);
        const allKeysAreOperators = keys.every(k => k.startsWith('$'));
        const containsLogicalOperator = keys.some(k => this.#isLogicalOperator(k));
        const isPrimitiveMatch = allKeysAreOperators && !containsLogicalOperator;

        let elemMatchConditions = '';
        let alias = 'elem'; 
        let arrayElementsFunc = 'jsonb_array_elements'; 
        
        if (isPrimitiveMatch) {
            arrayElementsFunc = 'jsonb_array_elements_text';
            alias = 'elem_val'; 
            const primitiveOperator = Object.keys(operand)[0];
            const primitiveOperand = Object.values(operand)[0];
            const primitiveAccessPath = `${alias}.value`; 
            // Pass null for jsonPath here as we are operating on extracted text primitive
            elemMatchConditions = this.#handleComparisonOperator(primitiveOperator, primitiveOperand, primitiveAccessPath, null as any); 
        } else {
             // Pass alias as the jsonField context for processing nested object
            elemMatchConditions = this.#processQueryObject(operand, alias, ''); // Changed jsonField to alias, parentPath to ''
        }
 
        if (!elemMatchConditions || elemMatchConditions === 'TRUE') {
            // If conditions are empty or TRUE, just check if it's a non-empty array
            return `(${jsonPath} IS NOT NULL AND jsonb_typeof(${jsonPath}) = 'array' AND jsonb_array_length(${jsonPath}) > 0)`;
        }
        
        return `EXISTS (SELECT 1 FROM ${arrayElementsFunc}(${jsonPath}) as ${alias} WHERE ${elemMatchConditions})`;
      }

      case '$type': {
          const typeMapping: Record<string, string> = {
              string: 'string', number: 'number', boolean: 'boolean',
              array: 'array', object: 'object', null: 'null'
          };
          const pgType = typeMapping[operand as string];
          if (!pgType) {
              console.warn(`Unsupported $type operand: ${operand}`);
              return 'FALSE';
          }
          return `jsonb_typeof(${jsonPath}) = ${sqlVal(pgType)}`;
      }

      case '$search': 
         console.warn('Unsupported operator: $search (part of $text, requires FTS configuration)');
         // Return empty string instead of TRUE for unsupported ops
         return ''; 
          
      default:
        console.warn(`Unsupported operator: ${operator}`);
        // Return empty string instead of TRUE for unsupported ops
        return ''; 
    }
  }

  #handleLogicalOperator(
    operator: string,
    operands: any,
    jsonField: string,
    parentPath: string
  ): string {
    switch (operator) {
      case '$and':
      case '$or': {
        if (!Array.isArray(operands)) {
          console.warn(`Invalid operand for ${operator}: expected an array`);
          return operator === '$and' ? 'TRUE' : 'FALSE';
        }
        if (operands.length === 0) {
           return operator === '$and' ? 'TRUE' : 'FALSE';
        }
        const clauses = operands.map((subQuery: Record<string, any>) => this.#processQueryObject(subQuery, jsonField, parentPath))
                              .filter(c => c && c !== 'TRUE');
        
        if (clauses.length === 0) return operator === '$and' ? 'TRUE' : 'FALSE';
        if (clauses.length === 1) {
            return clauses[0]; 
        }
        
        const joiner = operator === '$and' ? ' AND ' : ' OR ';
        const joined = clauses.join(joiner);
        return `(${joined})`;
      }
      case '$not': {
         if (typeof operands !== 'object' || operands === null || Array.isArray(operands)) {
            console.warn(`Invalid operand for $not: expected an expression object`);
            return 'FALSE'; 
         }
         let innerCondition = '';
         const keys = Object.keys(operands);
         if (keys.length > 0 && keys.every(k => k.startsWith('$')) && !this.#isLogicalOperator(keys[0])) {
             innerCondition = this.#processFieldOperators(operands, 'dummy_access', 'dummy_json');
         } else {
             innerCondition = this.#processQueryObject(operands as Record<string, any>, jsonField, parentPath);
         }
         
         if (!innerCondition || innerCondition === 'TRUE') return 'FALSE';
         if (innerCondition === 'FALSE') return 'TRUE';
         return `NOT (${innerCondition})`;
      }
      case '$nor': {
        if (!Array.isArray(operands)) {
          console.warn('Invalid operand for $nor: expected an array');
          return 'TRUE';
        }
        if (operands.length === 0) {
           return 'TRUE';
        }
        const clauses = operands.map((subQuery: Record<string, any>) => this.#processQueryObject(subQuery, jsonField, parentPath))
                               .filter(c => c && c !== 'TRUE');
        
        if (clauses.length === 0) return 'FALSE';
        
        const joinedOr = clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
        return `NOT (${joinedOr})`;
      }
      default:
        return '';
    }
  }

  #handleNotOperator(operand: any, accessPath: string, jsonPath: string): string {
    if (typeof operand !== 'object' || operand === null || Array.isArray(operand)) {
        console.warn(`Invalid operand for field-level $not: expected an object.`);
        return 'FALSE';
    }
    // Pass jsonPath down for potential null checks within operand
    const innerCondition = this.#processFieldOperators(operand, accessPath, jsonPath);

    if (!innerCondition || innerCondition === 'TRUE') {
        return 'FALSE';
    }
    if (innerCondition === 'FALSE') {
        return 'TRUE';
    }
    return `NOT (${innerCondition})`;
  }

  #isLogicalOperator(key: string): boolean {
    return ['$and', '$or', '$nor', '$not'].includes(key);
  }

  #isOperatorObject(value: any): boolean {
    return (
      typeof value === 'object' && 
      value !== null && 
      !Array.isArray(value) && 
      Object.keys(value).some(key => key.startsWith('$'))
    );
  }

  #sqlValue(value: any): string {
    if (value === undefined || value === null) {
      return 'NULL';
    }
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, "''")}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `'${JSON.stringify(value)}'`;
    }
    return `'${JSON.stringify(value)}'`;
  }

  #buildSortClause(sort: Record<string, SortDirection> | undefined, jsonField: string): string {
    if (!sort || Object.keys(sort).length === 0) {
      return '';
    }
    const sortClauses = Object.entries(sort).map(([key, direction]) => {
      // Convert 1 / -1 back to ASC / DESC
      const pgDirection = direction === 1 ? 'ASC' : 'DESC'; 
      
      let accessPath = '';
      if (key.includes('.')) {
          const parts = key.split('.');
          let currentPath = jsonField;
          for(let i = 0; i < parts.length; i++) {
              const part = parts[i];
              const isLastPart = i === parts.length - 1;
              const isNumericIndex = /^\d+$/.test(part);
              
              if (isNumericIndex) { 
                currentPath += `->${part}`;
              } else { 
                currentPath += `->'${part}'`; 
              }
              
              if (isLastPart) {
                  const basePathMatch = currentPath.match(/^(.*)(->'[^']+'|->\d+)$/);
                  const basePath = basePathMatch ? basePathMatch[1] : jsonField;
                  if (isNumericIndex) { 
                    accessPath = `${basePath}->>${part}`; 
                  } else { 
                    accessPath = `${basePath}->>'${part}'`; 
                  }
              }
          }
          if (!accessPath) accessPath = `${jsonField}->>'${key}'`;
      } else {
          accessPath = `${jsonField}->>'${key}'`;
      }
      
      return `${accessPath} ${pgDirection}`;
    });
    return ` ORDER BY ${sortClauses.join(', ')}`;
  }

  #buildJsonbPath(fieldPath: string): string {
    // Convert dot notation 'a.b.c' to Postgres jsonb path literal '{ "a", "b", "c" }'
    // Use JSON.stringify for robust quoting of path segments
    const segments = fieldPath.split('.').map(p => JSON.stringify(p)); 
    // Return the literal directly, wrapped in single quotes for SQL
    return `'{'${segments.join(',')}'}'`;
  }

  #buildJsonbAccessPath(fieldPath: string, jsonField: string): string {
    const parts = fieldPath.split('.');
    let currentPath = this.#quoteIdent(jsonField);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const quotedPart = this.#quoteLiteral(part);
      const isLast = i === parts.length - 1;
      currentPath += isLast ? `->>${quotedPart}` : `->${quotedPart}`;
    }
    return currentPath;
  }

  #quoteIdent(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  #quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }
}