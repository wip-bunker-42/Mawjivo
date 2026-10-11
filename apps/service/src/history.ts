import type { PostPage, Summary, PostDetail } from '@mawjivo/core';
import type { AuthContext } from './auth';
export async function listPosts(_auth:AuthContext,_workspaceId:string,_filter:'all'|'scheduled'|'needsAction',_cursor:string|undefined,_env:Env):Promise<PostPage>{throw new Error('NOT_IMPLEMENTED');}
export async function getSummary(_auth:AuthContext,_workspaceId:string,_localDate:string,_env:Env):Promise<Summary>{throw new Error('NOT_IMPLEMENTED');}
export async function getPostDetail(_auth:AuthContext,_postId:string,_env:Env):Promise<PostDetail>{throw new Error('NOT_IMPLEMENTED');}
