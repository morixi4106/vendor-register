import {
  createDraftOrderCheckoutLoader,
} from '../services/draftOrderCheckout.server.js';
import { createPublicVendorDraftOrderCheckoutAction } from '../services/vendorStorefront.server.js';

export const loader = createDraftOrderCheckoutLoader();
export const action = createPublicVendorDraftOrderCheckoutAction();
