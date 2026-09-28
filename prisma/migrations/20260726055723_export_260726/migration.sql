-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_created_by_fkey";

-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_invited_by_fkey";

-- DropForeignKey
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_notes" DROP CONSTRAINT "lead_notes_lead_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_notes" DROP CONSTRAINT "lead_notes_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_notes" DROP CONSTRAINT "lead_notes_user_id_fkey";

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_assigned_to_fkey";

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_property_id_fkey";

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "password_resets" DROP CONSTRAINT "password_resets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "properties" DROP CONSTRAINT "properties_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "properties" DROP CONSTRAINT "properties_user_id_fkey";

-- DropForeignKey
ALTER TABLE "property_images" DROP CONSTRAINT "property_images_property_id_fkey";

-- DropForeignKey
ALTER TABLE "property_images" DROP CONSTRAINT "property_images_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_endpoint_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_tenant_id_fkey";

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "invitations" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "email" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "lead_notes" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "leads" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "password_resets" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "properties" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "property_images" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "email" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "webhook_deliveries" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "webhook_endpoints" ALTER COLUMN "id" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "webhook_deliveries_estado_next_retry_at_idx" ON "webhook_deliveries"("estado", "next_retry_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_images" ADD CONSTRAINT "property_images_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_images" ADD CONSTRAINT "property_images_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_api_keys_tenant" RENAME TO "api_keys_tenant_id_idx";

-- RenameIndex
ALTER INDEX "idx_invitations_tenant" RENAME TO "invitations_tenant_id_idx";

-- RenameIndex
ALTER INDEX "idx_lead_notes_lead" RENAME TO "lead_notes_lead_id_idx";

-- RenameIndex
ALTER INDEX "idx_leads_assigned" RENAME TO "leads_assigned_to_idx";

-- RenameIndex
ALTER INDEX "idx_leads_tenant_canal" RENAME TO "leads_tenant_id_canal_idx";

-- RenameIndex
ALTER INDEX "idx_leads_tenant_estado" RENAME TO "leads_tenant_id_estado_idx";

-- RenameIndex
ALTER INDEX "idx_password_resets_user" RENAME TO "password_resets_user_id_idx";

-- RenameIndex
ALTER INDEX "idx_properties_tenant_created" RENAME TO "properties_tenant_id_created_at_idx";

-- RenameIndex
ALTER INDEX "idx_properties_tenant_estado" RENAME TO "properties_tenant_id_estado_idx";

-- RenameIndex
ALTER INDEX "idx_properties_tenant_user" RENAME TO "properties_tenant_id_user_id_idx";

-- RenameIndex
ALTER INDEX "idx_property_images_property" RENAME TO "property_images_property_id_orden_idx";

-- RenameIndex
ALTER INDEX "idx_refresh_tokens_user" RENAME TO "refresh_tokens_user_id_idx";

-- RenameIndex
ALTER INDEX "idx_users_tenant_email" RENAME TO "users_tenant_id_email_idx";

-- RenameIndex
ALTER INDEX "idx_webhook_endpoints_tenant" RENAME TO "webhook_endpoints_tenant_id_idx";
