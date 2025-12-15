import { client } from "./redisClient";
import { ParsedCommand } from "../types";

// ============================================
// Interaction Types (based on Towns protocol.proto)
// ============================================

/**
 * EVM Transaction content for InteractionRequestPayload.Transaction
 */
export interface EVMTransactionContent {
  chainId: string; // e.g., "8453" for Base
  to: string; // Contract address
  value: string; // Wei value as hex string
  data: string; // Calldata as hex string
  signerWallet?: string; // Optional: specific wallet to sign with
}

/**
 * Pending interaction stored in Redis
 */
export interface PendingInteraction {
  interactionId: string;
  userId: string;
  channelId: string;
  threadId: string;

  // The validated command
  command: ParsedCommand;

  // Transaction params from Rust
  txParams: EVMTransactionContent;

  // Metadata for display
  title: string;
  subtitle: string;

  // Timestamps
  createdAt: number;
  expiresAt: number;
}

/**
 * Response types from InteractionResponsePayload
 */
export interface TransactionResponse {
  requestId: string;
  txHash: string;
}

export interface FormResponse {
  requestId: string;
  components: Array<{
    id: string;
    button?: {};
    textInput?: { value: string };
  }>;
}

export interface SignatureResponse {
  requestId: string;
  signature: string;
}

// ============================================
// Constants
// ============================================

const INTERACTION_PREFIX = "interaction:";
const INTERACTION_TTL = 60 * 15; // 15 minutes

// ============================================
// Core Functions
// ============================================

/**
 * Store a pending interaction (waiting for user response)
 */
export async function storePendingInteraction(
  interaction: PendingInteraction,
): Promise<void> {
  const key = INTERACTION_PREFIX + interaction.interactionId;

  try {
    await client.hSet(key, {
      interactionId: interaction.interactionId,
      userId: interaction.userId,
      channelId: interaction.channelId,
      threadId: interaction.threadId,
      command: JSON.stringify(interaction.command),
      txParams: JSON.stringify(interaction.txParams),
      title: interaction.title,
      subtitle: interaction.subtitle,
      createdAt: interaction.createdAt.toString(),
      expiresAt: interaction.expiresAt.toString(),
    });

    await client.expire(key, INTERACTION_TTL);
  } catch (error) {
    console.error("Error storing pending interaction:", error);
    throw error;
  }
}

/**
 * Get a pending interaction by ID
 */
export async function getPendingInteraction(
  interactionId: string,
): Promise<PendingInteraction | null> {
  const key = INTERACTION_PREFIX + interactionId;

  try {
    const data = await client.hGetAll(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    // Check if expired
    const expiresAt = Number(data.expiresAt);
    if (Date.now() > expiresAt) {
      await deletePendingInteraction(interactionId);
      return null;
    }

    return {
      interactionId: data.interactionId,
      userId: data.userId,
      channelId: data.channelId,
      threadId: data.threadId,
      command: JSON.parse(data.command),
      txParams: JSON.parse(data.txParams),
      title: data.title,
      subtitle: data.subtitle,
      createdAt: Number(data.createdAt),
      expiresAt: Number(data.expiresAt),
    };
  } catch (error) {
    console.error("Error getting pending interaction:", error);
    return null;
  }
}

/**
 * Delete a pending interaction
 */
export async function deletePendingInteraction(
  interactionId: string,
): Promise<void> {
  const key = INTERACTION_PREFIX + interactionId;
  await client.del(key);
}

/**
 * Validate an interaction exists and belongs to the user
 */
export async function validateInteraction(
  interactionId: string,
  userId: string,
): Promise<{
  valid: boolean;
  interaction?: PendingInteraction;
  error?: string;
}> {
  const interaction = await getPendingInteraction(interactionId);

  if (!interaction) {
    return {
      valid: false,
      error: "This request has expired. Please start over.",
    };
  }

  if (interaction.userId !== userId) {
    return { valid: false, error: "This action belongs to another user." };
  }

  return { valid: true, interaction };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Generate a unique interaction ID
 */
export function generateInteractionId(): string {
  return `coco_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Create title and subtitle from command for the transaction dialog
 */
export function createTransactionMeta(command: ParsedCommand): {
  title: string;
  subtitle: string;
} {
  switch (command.action) {
    case "register": {
      const names = command.names.join(", ");
      const years =
        command.duration === 1 ? "1 year" : `${command.duration} years`;
      return {
        title: `Register ${names}`,
        subtitle: `Register ENS name for ${years}`,
      };
    }

    case "renew": {
      const names = command.names.join(", ");
      const years =
        command.duration === 1 ? "1 year" : `${command.duration} years`;
      return {
        title: `Renew ${names}`,
        subtitle: `Extend registration for ${years}`,
      };
    }

    case "transfer": {
      const name = command.names[0];
      const shortAddr = `${command.recipient.slice(0, 6)}...${command.recipient.slice(-4)}`;
      return {
        title: `Transfer ${name}`,
        subtitle: `Send to ${shortAddr}`,
      };
    }

    case "set": {
      const name = command.names[0];
      const recordCount = Object.keys(command.records).length;
      return {
        title: `Update ${name}`,
        subtitle: `Set ${recordCount} record(s)`,
      };
    }

    default:
      return {
        title: `ENS ${command.action}`,
        subtitle: "Confirm transaction",
      };
  }
}
