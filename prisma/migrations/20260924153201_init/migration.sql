-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('HEALTHY', 'OFFLINE', 'DEGRADED');

-- CreateEnum
CREATE TYPE "ReplicaStatus" AS ENUM ('SYNCED', 'STALE', 'CORRUPTED', 'MISSING', 'REPAIRING');

-- CreateEnum
CREATE TYPE "RepairType" AS ENUM ('REPLICA_REPAIR', 'SCRUB', 'REBALANCE', 'NODE_FAILOVER');

-- CreateEnum
CREATE TYPE "ChaosAction" AS ENUM ('KILL_NODE', 'REVIVE_NODE', 'CORRUPT_CHUNK', 'PARTITION_NODE', 'HEAL_PARTITION');

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "backendPrefix" TEXT NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'HEALTHY',
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCorrupting" BOOLEAN NOT NULL DEFAULT false,
    "isPartitioned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoredObject" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "contentType" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT NOT NULL,
    "replicationFactor" INTEGER NOT NULL DEFAULT 3,
    "writeQuorum" INTEGER NOT NULL DEFAULT 2,
    "readQuorum" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Replica" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "ReplicaStatus" NOT NULL DEFAULT 'SYNCED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairLog" (
    "id" TEXT NOT NULL,
    "type" "RepairType" NOT NULL,
    "chunkId" TEXT,
    "nodeId" TEXT,
    "detail" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepairLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChaosEvent" (
    "id" TEXT NOT NULL,
    "action" "ChaosAction" NOT NULL,
    "nodeId" TEXT,
    "chunkId" TEXT,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChaosEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Node_name_key" ON "Node"("name");

-- CreateIndex
CREATE INDEX "Node_status_idx" ON "Node"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StoredObject_key_key" ON "StoredObject"("key");

-- CreateIndex
CREATE INDEX "StoredObject_key_idx" ON "StoredObject"("key");

-- CreateIndex
CREATE INDEX "Chunk_objectId_idx" ON "Chunk"("objectId");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_objectId_index_key" ON "Chunk"("objectId", "index");

-- CreateIndex
CREATE INDEX "Replica_nodeId_idx" ON "Replica"("nodeId");

-- CreateIndex
CREATE INDEX "Replica_status_idx" ON "Replica"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Replica_chunkId_nodeId_key" ON "Replica"("chunkId", "nodeId");

-- CreateIndex
CREATE INDEX "RepairLog_type_idx" ON "RepairLog"("type");

-- CreateIndex
CREATE INDEX "RepairLog_createdAt_idx" ON "RepairLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "StoredObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Replica" ADD CONSTRAINT "Replica_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Replica" ADD CONSTRAINT "Replica_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
