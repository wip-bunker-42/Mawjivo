CREATE UNIQUE INDEX IF NOT EXISTS assets_active_source ON assets(workspace_id,source_asset_id,COALESCE(recipe_id,'')) WHERE state!='deleted';
