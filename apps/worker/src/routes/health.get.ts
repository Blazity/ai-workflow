import { defineEventHandler } from "h3";
import { healthResponse } from "../services/system/index.js";

export default defineEventHandler(() => healthResponse());
