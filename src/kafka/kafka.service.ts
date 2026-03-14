// =============================================================================
// src/kafka/kafka.service.ts — Kafka producer & consumer service (NestJS)
// =============================================================================
// Injectable NestJS service wrapping KafkaJS.
//
// REPLACES: Express kafkaClient singleton
// NestJS ADVANTAGE: The service implements OnModuleInit and OnModuleDestroy
// lifecycle hooks, so Kafka connects on startup and disconnects on shutdown
// automatically — no manual bootstrap/graceful-shutdown code needed.
// =============================================================================

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Kafka, logLevel, Producer, Consumer } from 'kafkajs';
import { ZodSchema } from 'zod';
import { ConfigService } from '../config/config.service';
import { LoggerService } from '../shared/logger.service';
import { TOPICS } from './topics';
import {
  GatewayRequestEventSchema,
  GatewayResponseEventSchema,
  GatewayErrorEventSchema,
  AuditLogEventSchema,
  ExternalRequestEventSchema,
  RegistryServiceRegisteredEventSchema,
  RegistryServiceDeregisteredEventSchema,
  RegistryServiceDeprecatedEventSchema,
  RegistryServiceRetiredEventSchema,
  RegistryServiceVersionChangedEventSchema,
  RegistryServiceHealthChangedEventSchema,
  TribeRequestEventSchema,
  TribeResponseEventSchema,
  TokenIssuedEventSchema,
  TokenRefreshedEventSchema,
  TokenRevokedEventSchema,
} from './schemas';

/**
 * Maps each Kafka topic to its Zod validation schema.
 * Topics not listed here are published without validation.
 */
const TOPIC_SCHEMAS: Record<string, ZodSchema> = {
  [TOPICS.GATEWAY_REQUEST]: GatewayRequestEventSchema,
  [TOPICS.GATEWAY_RESPONSE]: GatewayResponseEventSchema,
  [TOPICS.GATEWAY_ERROR]: GatewayErrorEventSchema,
  [TOPICS.AUDIT_LOG]: AuditLogEventSchema,
  [TOPICS.EXTERNAL_REQUEST]: ExternalRequestEventSchema,
  [TOPICS.SERVICE_REGISTERED]: RegistryServiceRegisteredEventSchema,
  [TOPICS.SERVICE_DEREGISTERED]: RegistryServiceDeregisteredEventSchema,
  [TOPICS.SERVICE_DEPRECATED]: RegistryServiceDeprecatedEventSchema,
  [TOPICS.SERVICE_RETIRED]: RegistryServiceRetiredEventSchema,
  [TOPICS.SERVICE_VERSION_CHANGED]: RegistryServiceVersionChangedEventSchema,
  [TOPICS.SERVICE_HEALTH_CHANGED]: RegistryServiceHealthChangedEventSchema,
  [TOPICS.TRIBE_REQUEST]: TribeRequestEventSchema,
  [TOPICS.TRIBE_RESPONSE]: TribeResponseEventSchema,
  [TOPICS.TOKEN_ISSUED]: TokenIssuedEventSchema,
  [TOPICS.TOKEN_REFRESHED]: TokenRefreshedEventSchema,
  [TOPICS.TOKEN_REVOKED]: TokenRevokedEventSchema,
};

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers: Map<string, Consumer> = new Map();
  private connected = false;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {
    this.kafka = new Kafka({
      clientId: this.config.kafka.clientId,
      brokers: this.config.kafka.brokers,
      logLevel: logLevel.WARN,
    });

    this.producer = this.kafka.producer();
  }

  /** NestJS lifecycle: connect Kafka producer when the module initializes */
  async onModuleInit() {
    try {
      await this.producer.connect();
      this.connected = true;
      this.logger.log('Kafka producer connected', 'KafkaService');
    } catch (err) {
      this.logger.error(
        `Kafka producer failed to connect: ${(err as Error).message}`,
        (err as Error).stack,
        'KafkaService',
      );
    }
  }

  /** NestJS lifecycle: gracefully disconnect on application shutdown */
  async onModuleDestroy() {
    await this.producer.disconnect();
    this.connected = false;
    for (const consumer of this.consumers.values()) {
      await consumer.disconnect();
    }
    this.logger.log('Kafka disconnected', 'KafkaService');
  }

  /** Check if the producer is currently connected */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Publish an event to a Kafka topic.
   * If a Zod schema exists for the topic, the payload is validated first.
   * @param topic   - One of the topics defined in kafka/topics.ts
   * @param payload - Arbitrary JSON-serializable data
   * @param key     - Optional partition key (e.g. tribeId) for ordering
   * @throws Error if payload fails Zod validation
   */
  async publish(topic: string, payload: Record<string, unknown>, key?: string): Promise<void> {
    // ---- Schema validation ----
    const schema = TOPIC_SCHEMAS[topic];
    if (schema) {
      const result = schema.safeParse(payload);
      if (!result.success) {
        const errorMsg = `Kafka schema validation failed for topic '${topic}': ${result.error.message}`;
        this.logger.error(errorMsg, undefined, 'KafkaService');
        throw new Error(errorMsg);
      }
    }

    await this.producer.send({
      topic,
      messages: [
        {
          key: key ? String(key) : undefined,
          value: JSON.stringify({
            ...payload,
            _meta: {
              timestamp: new Date().toISOString(),
              source: this.config.kafka.clientId,
            },
          }),
        },
      ],
    });
  }

  /**
   * Subscribe a handler function to a Kafka topic.
   * Creates a dedicated consumer per topic.
   */
  async subscribe(
    topic: string,
    handler: (message: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId: `${this.config.kafka.groupId}-${topic}`,
    });

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const parsed = JSON.parse(message.value?.toString() || '{}');
          await handler(parsed);
        } catch (err) {
          this.logger.error(
            `Kafka message processing error on ${topic}: ${(err as Error).message}`,
            (err as Error).stack,
            'KafkaService',
          );
        }
      },
    });

    this.consumers.set(topic, consumer);
    this.logger.log(`Kafka subscribed to topic: ${topic}`, 'KafkaService');
  }
}
