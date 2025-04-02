// utility functions for the orm
import inflection from 'inflection';

export function singularize(word: string): string {
  return inflection.singularize(word);
}

export function pluralize(word: string): string {
  return inflection.pluralize(word);
}

// Function to renumber placeholders (e.g., $1, $2) in a SQL string starting from a given index.
export function renumberPlaceholders(sql: string, startingIndex: number): string {
  return sql.replace(/\$(\d+)/g, (_, num) => `$${parseInt(num) + startingIndex}`);
} 