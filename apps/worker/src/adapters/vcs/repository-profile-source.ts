/**
 * The repository profile vocabulary core still reads.
 *
 * Building a profile belongs to the integration that can read the repository;
 * what is left here is what core does with a bundle it was handed, which is why
 * only the reader's half of the vocabulary is re-exported. Anything narrower
 * than this, such as the per-file predicates a builder needs, is imported from
 * `@integrations/sdk` where it is defined.
 */
export {
  boundRepositoryProfileBundle,
  pickRepositoryProfileReadme,
  RepositoryMissingAtProviderError,
  REPOSITORY_PROFILE_DEADLINE_MS,
  REPOSITORY_PROFILE_TRUNCATION_MARKER,
  type RepositoryProfileBundle,
} from "@integrations/sdk";
