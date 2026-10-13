// utility functions for the orm
import inflection from "inflection";

export function singularize(word: string): string {
  return inflection.singularize(word);
}

export function pluralize(word: string): string {
  return inflection.pluralize(word);
}
