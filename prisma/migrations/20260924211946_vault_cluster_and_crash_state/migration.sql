/*
  Warnings:

  - A unique constraint covering the columns `[cluster,name]` on the table `Node` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[cluster,key]` on the table `StoredObject` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Node_name_key";

-- DropIndex
DROP INDEX "Node_status_idx";

-- DropIndex
DROP INDEX "RepairLog_createdAt_idx";

-- DropIndex
DROP INDEX "StoredObject_key_idx";

-- DropIndex
DROP INDEX "StoredObject_key_key";

-- AlterTable
ALTER TABLE "ChaosEvent" ADD COLUMN     "cluster" TEXT NOT NULL DEFAULT 'main';

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "cluster" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "isCrashed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RepairLog" ADD COLUMN     "cluster" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "objectKey" TEXT;

-- AlterTable
ALTER TABLE "StoredObject" ADD COLUMN     "cluster" TEXT NOT NULL DEFAULT 'main';

-- CreateIndex
CREATE INDEX "ChaosEvent_cluster_createdAt_idx" ON "ChaosEvent"("cluster", "createdAt");

-- CreateIndex
CREATE INDEX "Node_cluster_status_idx" ON "Node"("cluster", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Node_cluster_name_key" ON "Node"("cluster", "name");

-- CreateIndex
CREATE INDEX "RepairLog_cluster_createdAt_idx" ON "RepairLog"("cluster", "createdAt");

-- CreateIndex
CREATE INDEX "StoredObject_cluster_idx" ON "StoredObject"("cluster");

-- CreateIndex
CREATE UNIQUE INDEX "StoredObject_cluster_key_key" ON "StoredObject"("cluster", "key");
