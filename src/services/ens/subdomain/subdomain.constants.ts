/**
 * ENS NameWrapper Fuses
 * These control what can be done with wrapped names
 */
export const FUSES = {
  // Parent-controlled fuses
  CANNOT_UNWRAP: 1,
  CANNOT_BURN_FUSES: 2,
  CANNOT_TRANSFER: 4,
  CANNOT_SET_RESOLVER: 8,
  CANNOT_SET_TTL: 16,
  CANNOT_CREATE_SUBDOMAIN: 32,
  CANNOT_APPROVE: 64,

  // Parent-controlled fuses for subnames
  PARENT_CANNOT_CONTROL: 65536, // 2^16 - Makes subname "emancipated"
  CAN_EXTEND_EXPIRY: 262144, // 2^18 - Allows subname owner to extend expiry

  // Common combinations
  EMANCIPATED: 65536, // Just PARENT_CANNOT_CONTROL
  EMANCIPATED_AND_EXTENDABLE: 65536 | 262144, // PARENT_CANNOT_CONTROL | CAN_EXTEND_EXPIRY
};
