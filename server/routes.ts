import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupGateway } from "./gateway";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerFeedRoutes } from "./modules/feed/routes";
import { registerProfileRoutes } from "./modules/profile/routes";
import { registerSystemRoutes } from "./modules/system/routes";
import { registerChatroomRoutes } from "./modules/chatroom/routes";
import { registerRoomRoutes } from "./modules/room/routes";
import { registerLostRoutes } from "./modules/lost/routes";
import { registerMerchantRoutes } from "./modules/merchant/routes";
import { registerMerchantTagRoutes } from "./modules/merchant-tag/routes";
import { registerDiscoveryRoutes } from "./modules/discovery/routes";
import { registerCreditRoutes } from "./modules/credit/routes";
import { registerMigCommandRoutes } from "./modules/migcommand/routes";
import { registerChatSyncRoutes } from "./modules/chatsync/routes";
import { registerContactsRoutes } from "./modules/contacts/routes";
import { registerBotRoutes } from "./modules/bot/routes";
import { registerEmoStickerRoutes } from "./modules/emosticker/routes";
import { registerGuardsetRoutes } from "./modules/guardset/routes";
import { registerCampaignRoutes } from "./modules/campaign/routes";
import { registerEmailRoutes } from "./modules/email/routes";
import { registerGroupRoutes } from "./modules/group/routes";
import { registerBotHunterRoutes } from "./modules/bothunter/routes";
import { registerBotServiceRoutes } from "./modules/botservice/routes";
import { registerLeaderboardRoutes } from "./modules/leaderboard/routes";
import { registerInvitationRoutes } from "./modules/invitation/routes";
import { registerReputationRoutes } from "./modules/reputation/routes";
import { registerPaymentRoutes } from "./modules/payment/routes";
import { registerSearchRoutes } from "./modules/search/routes";
import { registerUserEventRoutes } from "./modules/userevent/routes";
import { registerFashionShowRoutes } from "./modules/fashionshow/routes";
import { registerPaintwarsRoutes } from "./modules/paintwars/routes";
import { registerSmsEngineRoutes } from "./modules/smsengine/routes";
import { registerVoiceEngineRoutes } from "./modules/voiceengine/routes";
import { registerImageServerRoutes } from "./modules/imageserver/routes";
import { registerMessageSwitchboardRoutes } from "./modules/messageswitchboard/routes";
import { registerUnsRoutes } from "./modules/uns/routes";
import { registerStoreRoutes } from "./modules/store/routes";
import { registerSettingsRoutes } from "./modules/settings/routes";
import { registerAdminGiftRoutes } from "./modules/gifts/routes";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  setupGateway(httpServer);

  registerAuthRoutes(app);
  registerFeedRoutes(app);
  registerProfileRoutes(app);
  registerSystemRoutes(app);
  registerChatroomRoutes(app);
  registerRoomRoutes(app);
  registerLostRoutes(app);
  registerMerchantRoutes(app);
  registerMerchantTagRoutes(app);
  registerDiscoveryRoutes(app);
  registerCreditRoutes(app);
  registerMigCommandRoutes(app);
  registerChatSyncRoutes(app);
  registerContactsRoutes(app);
  registerBotRoutes(app);
  registerEmoStickerRoutes(app);
  registerGuardsetRoutes(app);
  registerCampaignRoutes(app);
  registerEmailRoutes(app);
  registerGroupRoutes(app);
  registerBotHunterRoutes(app);
  registerBotServiceRoutes(app);
  registerLeaderboardRoutes(app);
  registerInvitationRoutes(app);
  registerReputationRoutes(app);
  registerPaymentRoutes(app);
  registerSearchRoutes(app);
  registerUserEventRoutes(app);
  registerFashionShowRoutes(app);
  registerPaintwarsRoutes(app);
  registerSmsEngineRoutes(app);
  registerVoiceEngineRoutes(app);
  registerImageServerRoutes(app);
  registerMessageSwitchboardRoutes(app);
  registerUnsRoutes(app);
  registerStoreRoutes(app);
  registerSettingsRoutes(app);
  registerAdminGiftRoutes(app);

  return httpServer;
}
