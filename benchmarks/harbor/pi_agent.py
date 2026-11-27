"""Harbor's built-in Pi adapter with an optional Debian mirror workaround."""

from typing import Literal

from harbor.agents.installed.pi import Pi, PiOptions
from harbor.environments.base import BaseEnvironment

from .owl_agent import configure_debian_mirror


class LocalPiOptions(PiOptions):
    debian_mirror: Literal["aliyun", "tuna"] | None = None


class LocalPi(Pi):
    options_model = LocalPiOptions
    options: LocalPiOptions

    def _build_custom_models_json(self, access, model_id):
        # The standard DeepSeek endpoint does not require a synthetic Pi model.
        # Harbor 0.27 otherwise treats DEEPSEEK_BASE_URL from a user's env file
        # as a custom endpoint and requires an explicit API-format override.
        if (
            access.provider == "deepseek"
            and (access.execution_base_url or "").rstrip("/")
            in ("https://api.deepseek.com", "https://api.deepseek.com/v1")
            and self.options.model_api is None
            and self._model_api_format is None
        ):
            return None
        return super()._build_custom_models_json(access, model_id)

    async def install(self, environment: BaseEnvironment) -> None:
        if self.options.debian_mirror:
            await configure_debian_mirror(self, environment, self.options.debian_mirror)
        # Keep task-side utilities the same as the Owl environment.
        await self.ensure_system_dependencies(environment, ("bash", "curl", "git", "tar", "ripgrep"))
        await super().install(environment)
